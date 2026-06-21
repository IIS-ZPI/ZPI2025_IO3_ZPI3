/**
 * Custom error class for NBP API related issues.
 */
class NBPServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "NBPServiceError";
    this.status = status;
  }
}

/**
 * Service class to handle all communication with the National Bank of Poland API.
 */
class NBPService {
  constructor() {
    this.baseUrl = "https://api.nbp.pl/api";
    this.MIN_DATE = "2002-01-02";
    this.GOLD_MIN_DATE = "2013-01-02";
  }

  /**
   * Helper to round numbers to 4 decimal places as per requirements.
   * @param {number} val - Value to round.
   * @returns {number} Rounded value.
   */
  round(val) {
    return Math.round((val + Number.EPSILON) * 10000) / 10000;
  }

  /**
   * Formats a Date object to YYYY-MM-DD string.
   * @param {Date} date - Date object.
   * @returns {string} Formatted date.
   */
  formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  /**
   * Fetches exchange rates for a given currency and range.
   * @param {string} table - NBP table (A, B, or C).
   * @param {string} code - Currency code.
   * @param {string} startDate - Range start (YYYY-MM-DD).
   * @param {string} endDate - Range end (YYYY-MM-DD).
   * @returns {Promise<Array>} Array of rate objects.
   */
  async fetchRates(table, code, startDate, endDate) {
    const t = (table || "A").toLowerCase();
    const url = `${this.baseUrl}/exchangerates/rates/${t}/${code.toLowerCase()}/${startDate}/${endDate}/?format=json`;
    
    const res = await fetch(url);
    
    if (!res.ok) {
      if (res.status === 404) {
        throw new NBPServiceError(`No data for ${code} in selected range.`, 404);
      }
      throw new NBPServiceError(`NBP API error for ${code}.`, res.status);
    }
    
    const json = await res.json();
    return json.rates.map((r) => {
      const rawValue = r.mid != null ? r.mid : (r.bid + r.ask) / 2;
      return {
        date: r.effectiveDate,
        value: this.round(rawValue),
        bid: r.bid,
        ask: r.ask,
      };
    });
  }

  /**
   * Fetches gold prices for a given range.
   */
  async fetchGold(startDate, endDate) {
    const url = `${this.baseUrl}/cenyzlota/${startDate}/${endDate}/?format=json`;
    const res = await fetch(url);
    
    if (!res.ok) {
      if (res.status === 404) {
        throw new NBPServiceError("No gold price data in selected range.", 404);
      }
      throw new NBPServiceError("NBP API error for gold prices.", res.status);
    }
    
    const json = await res.json();
    return json.map((r) => ({ 
      date: r.data, 
      value: this.round(r.cena) 
    }));
  }

  /**
   * Fetches data in chunks to bypass NBP API's 367-day limit.
   */
  async fetchRangeChunked(table, code, startStr, endStr) {
    const out = [];
    let s = new Date(startStr);
    const end = new Date(endStr);
    
    while (s <= end) {
      const chunkEnd = new Date(s);
      chunkEnd.setDate(chunkEnd.getDate() + 360);
      const e = chunkEnd > end ? end : chunkEnd;
      
      const part = await this.fetchRates(table, code, this.formatDate(s), this.formatDate(e));
      out.push(...part);
      
      s = new Date(e);
      s.setDate(s.getDate() + 1);
    }
    
    const seen = new Set();
    return out.filter((r) => (seen.has(r.date) ? false : (seen.add(r.date), true)));
  }
}

/**
 * Service class responsible for processing and analyzing currency data.
 */
class AnalysisService {
  /**
   * Helper to round numbers to 4 decimal places.
   * @param {number} val - Value to round.
   * @returns {number} Rounded value.
   */
  round(val) {
    return Math.round((val + Number.EPSILON) * 10000) / 10000;
  }

  /**
   * Calculates the median of an array of numbers.
   * @param {Array<number>} arr - Array of values.
   * @returns {number} The median value.
   */
  median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    const result = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    return this.round(result);
  }

  /**
   * Calculates the mode (most frequent value) of an array.
   * Values are grouped by 4-decimal precision strings.
   * @param {Array<number>} arr - Array of values.
   * @returns {Object} Object containing the value and its count.
   */
  mode(arr) {
    const counts = new Map();
    for (const v of arr) {
      const k = v.toFixed(4);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null, bestC = 0;
    for (const [k, c] of counts) {
      if (c > bestC) {
        bestC = c;
        best = k;
      }
    }
    return { value: parseFloat(best), count: bestC };
  }

  /**
   * Calculates standard deviation and mean using the population formula.
   * @param {Array<number>} arr - Array of values.
   * @returns {Object} Object containing mean and standard deviation (std).
   */
  stddev(arr) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
    return { 
      mean: this.round(mean), 
      std: this.round(Math.sqrt(variance)) 
    };
  }

  /**
   * Performs a full statistical analysis on a set of exchange rates.
   * @param {Array} rates - Array of rate objects {date, value}.
   * @returns {Object} Full statistical report.
   */
  analyzeStats(rates) {
    const vals = rates.map((r) => r.value);
    const { mean, std } = this.stddev(vals);
    const cv = mean !== 0 ? (std / mean) * 100 : 0;

    return {
      count: vals.length,
      median: this.median(vals),
      mode: this.mode(vals),
      mean: mean,
      std: std,
      cv: this.round(cv),
      min: this.round(Math.min(...vals)),
      max: this.round(Math.max(...vals))
    };
  }

  /**
   * Analyzes sequential exchange rate sessions to determine market trends.
   * Compares each session to the previous one.
   * 
   * @param {Array} rates - Array of rate objects {date, value}.
   * @returns {Object} An object containing counts (up, down, flat) and detailed rows.
   */
  analyzeSessions(rates) {
    let up = 0, down = 0, flat = 0;
    const rows = [];

    // We start from the second element to compare it with the previous one
    for (let i = 1; i < rates.length; i++) {
      const diff = rates[i].value - rates[i - 1].value;
      let cls = "flat";

      if (diff > 0) {
        up++;
        cls = "up";
      } else if (diff < 0) {
        down++;
        cls = "down";
      } else {
        flat++;
      }

      rows.push({
        date: rates[i].date,
        value: rates[i].value,
        diff: diff,
        cls: cls
      });
    }

    return { up, down, flat, rows };
  }

  /**
   * Analyzes the distribution of percentage changes for a currency pair.
   * Logic: Synchronizes dates, calculates cross-rates, groups by period, 
   * calculates delta %, and bins results for a histogram.
   * 
   * @param {Array} ratesA - Rates for the first currency.
   * @param {Array} ratesB - Rates for the second currency.
   * @param {string} granularity - 'monthly' or 'quarterly'.
   * @returns {Object} Changes list and histogram bins.
   */
  analyzeDistribution(ratesA, ratesB, granularity) {
    // 1. Synchronize dates and calculate cross-rate (A/B)
    const mapB = new Map(ratesB.map((r) => [r.date, r.value]));
    const merged = ratesA
      .filter((r) => mapB.has(r.date))
      .map((r) => ({ 
        date: r.date, 
        value: r.value / mapB.get(r.date) 
      }));

    // 2. Group by month or quarter and take the last observation of each period
    const buckets = new Map();
    for (const r of merged) {
      const d = new Date(r.date);
      const key = granularity === "monthly"
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
        : `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
      buckets.set(key, r.value); // Overwrites until the last day of the period is reached
    }

    // 3. Sort periods and calculate percentage changes between them
    const ordered = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const changes = [];
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1][1];
      const cur = ordered[i][1];
      const pct = ((cur - prev) / prev) * 100;
      changes.push({ period: ordered[i][0], change: this.round(pct) });
    }

    if (!changes.length) return { changes, bins: [] };

    // 4. Generate Histogram Bins (10 intervals)
    const values = changes.map((c) => c.change);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const binCount = 10;
    const range = max - min || 1;
    const step = range / binCount;

    const bins = Array.from({ length: binCount }, (_, i) => ({
      from: this.round(min + i * step),
      to: this.round(min + (i + 1) * step),
      count: 0,
    }));

    // 5. Assign changes to bins
    for (const c of changes) {
      let idx = Math.floor((c.change - min) / step);
      if (idx >= binCount) idx = binCount - 1; // Handle edge case of the max value
      bins[idx].count++;
    }

    return { changes, bins };
  }
}

/**
 * Main Facade class that provides a consolidated interface for all currency analysis use cases.
 * Implements UC-001, UC-002, and UC-003.
 */
class CurrencyAnalyzer {
  constructor() {
    this.nbpService = new NBPService();
    this.analysisService = new AnalysisService();
  }

  /**
   * UC-001: Orchestrates the analysis of trading sessions.
   */
  async getSessionAnalysis(table, code, startDate, endDate) {
    const rates = await this.nbpService.fetchRates(table, code, startDate, endDate);
    if (rates.length < 2) throw new Error("Not enough data points for session analysis.");
    return this.analysisService.analyzeSessions(rates);
  }

  /**
   * UC-002: Orchestrates the calculation of statistical measures.
   */
  async getStatistics(table, code, startDate, endDate) {
    const rates = await this.nbpService.fetchRates(table, code, startDate, endDate);
    return {
      rates,
      stats: this.analysisService.analyzeStats(rates)
    };
  }

  /**
   * UC-003: Orchestrates cross-rate distribution analysis.
   */
  async getDistribution(table, codeA, codeB, startDate, endDate, granularity) {
    if (codeA === codeB) throw new Error("Pick two different currencies for the pair.");
    
    // Parallel fetching for performance
    const [ratesA, ratesB] = await Promise.all([
      this.nbpService.fetchRangeChunked(table, codeA, startDate, endDate),
      this.nbpService.fetchRangeChunked(table, codeB, startDate, endDate)
    ]);

    const distribution = this.analysisService.analyzeDistribution(ratesA, ratesB, granularity);
    if (!distribution.changes.length) throw new Error("Not enough data to compute distribution changes.");
    
    return distribution;
  }
}

/**
 * Handles the generation and downloading of CSV files.
 */
class CSVExporter {
  /**
   * Converts headers and rows into a single, properly formatted CSV string.
   * It handles escaping of double quotes within cells.
   * 
   * @param {Array<string>} headers - The column headers.
   * @param {Array<Array<any>>} rows - The data rows.
   * @returns {string} The complete CSV content.
   */
  generateCSVString(headers, rows) {
    const allRows = [headers, ...rows];
    return allRows
      .map(row => 
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");
  }

  /**
   * Triggers a browser download for the given CSV content.
   * This method interacts with the DOM and is intended for client-side execution.
   * 
   * @param {string} csvContent - The string generated by generateCSVString.
   * @param {string} baseFilename - The base name for the file (e.g., 'nbp-analysis').
   */
  download(csvContent, baseFilename) {
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${baseFilename}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

/**
 * UI Controller for managing the frontend interactions and view states.
 */
class UIController {
  constructor() {
    // Only initialize if document exists (prevents test crashes)
    if (typeof document === 'undefined') 
        return;

    this.els = {
      analysisType: document.getElementById("analysisType"),
      tableType: document.getElementById("tableType"),
      currency: document.getElementById("currency"),
      currencyB: document.getElementById("currencyB"),
      currencyBWrap: document.getElementById("currencyBWrap"),
      period: document.getElementById("period"),
      startDate: document.getElementById("startDate"),
      startDateWrap: document.getElementById("startDateWrap"),
      distGran: document.getElementById("distGran"),
      distGranWrap: document.getElementById("distGranWrap"),
      runBtn: document.getElementById("runBtn"),
      exportBtn: document.getElementById("exportBtn"),
      status: document.getElementById("status"),
      results: document.getElementById("results"),
      tabs: document.querySelectorAll(".tab"),
      chart: document.getElementById("chart"),
      chartWrap: document.getElementById("chartWrap"),
      tableWrap: document.getElementById("tableWrap"),
      nbpTableWrap: document.getElementById("nbpTableWrap"),
      currencyWrap: document.getElementById("currencyWrap")
    };

    this.CURRENCIES_A = [
      ["USD","US Dollar"],["EUR","Euro"],["GBP","British Pound"],["CHF","Swiss Franc"],
      ["JPY","Japanese Yen"],["CZK","Czech Koruna"],["SEK","Swedish Krona"],
      ["NOK","Norwegian Krone"],["DKK","Danish Krone"],["CAD","Canadian Dollar"],
      ["AUD","Australian Dollar"],["HUF","Hungarian Forint"],["CNY","Chinese Yuan"],
      ["UAH","Ukrainian Hryvnia"],["TRY","Turkish Lira"]
    ];
    this.CURRENCIES_B = [
      ["BGN","Bulgarian Lev"],["BRL","Brazilian Real"],["INR","Indian Rupee"],
      ["MXN","Mexican Peso"],["ZAR","South African Rand"],["IDR","Indonesian Rupiah"],
      ["KRW","South Korean Won"],["RON","Romanian Leu"],["THB","Thai Baht"],
      ["VND","Vietnamese Dong"],["PHP","Philippine Peso"]
    ];
    this.CURRENCIES_C = [
      ["USD","US Dollar"],["EUR","Euro"],["GBP","British Pound"],["CHF","Swiss Franc"]
    ];

    this.analyzer = new CurrencyAnalyzer();
    this.exporter = new CSVExporter();
    this.lastExportData = null;

    this.initListeners();
    this.populateCurrencies();
    this.setDefaultDates();
  }

  /**
   * Sets the default start date and constraints.
   */
  setDefaultDates() {
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(today.getFullYear() - 1);
    
    if (this.els.startDate) {
      this.els.startDate.value = oneYearAgo.toISOString().slice(0, 10);
      this.els.startDate.max = today.toISOString().slice(0, 10);
    }
  }

  /**
   * Populates the currency dropdowns based on the selected NBP table.
   */
  populateCurrencies() {
    const t = this.els.tableType.value;
    const list = t === "B" ? this.CURRENCIES_B : t === "C" ? this.CURRENCIES_C : this.CURRENCIES_A;
    
    this.els.currency.innerHTML = "";
    this.els.currencyB.innerHTML = "";
    
    list.forEach(([code, name]) => {
      this.els.currency.add(new Option(`${code} — ${name}`, code));
      this.els.currencyB.add(new Option(`${code} — ${name}`, code));
    });
  }

  /**
   * Toggles field visibility based on analysis type.
   */
  updateFieldVisibility() {
    const t = this.els.analysisType.value;
    const isDist = t === "distribution";
    const isGold = t === "gold";

    this.els.currencyBWrap.hidden = !isDist;
    this.els.startDateWrap.hidden = !isDist;
    this.els.distGranWrap.hidden = !isDist;
    this.els.period.parentElement.hidden = isDist;
    this.els.nbpTableWrap.hidden = isGold;
    this.els.currencyWrap.hidden = isGold;
  }

  switchView(tab) {
    this.els.tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const v = tab.dataset.view;
    this.els.chartWrap.hidden = v !== "chart";
    this.els.tableWrap.hidden = v !== "table";
  }

  setStatus(msg, isError = false) {
    this.els.status.textContent = msg;
    this.els.status.classList.toggle("error", isError);
  }

  /**
   * Captures the current analysis results for export (Issue #10).
   * @param {string} title - The title of the analysis.
   * @param {Object} exportData - Object with headers and rows.
   */
  prepareExport(title, exportData) {
    this.lastExportData = { title, ...exportData };
    this.els.exportBtn.disabled = false;
  }

  /**
   * Triggers the CSV export process.
   */
  handleExport() {
    if (!this.lastExportData) return;
    
    const csvContent = this.exporter.generateCSVString(
      this.lastExportData.headers, 
      this.lastExportData.rows
    );
    
    this.exporter.download(csvContent, `nbp-analysis-${this.lastExportData.title}`);
  }

  /**
   * Executes the analysis flow based on user input.
   */
  async run() {
    this.clearResults();
    this.setStatus("Fetching data from NBP API...");
    
    const type = this.els.analysisType.value;
    const table = this.els.tableType.value;
    const code = this.els.currency.value;
    const codeB = this.els.currencyB.value;
    const periodDays = parseInt(this.els.period.value, 10);
    const granularity = this.els.distGran.value;
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - periodDays);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    try {
      this.els.results.hidden = false;
      this.els.runBtn.disabled = true;

      if (type === "sessions") {
        const data = await this.analyzer.getSessionAnalysis(table, code, startStr, endStr);
        this.renderSessions(code, data);
        this.renderTable(["Date", "Rate", "Change", "Direction"], data.rows.map(r => [r.date, r.value, r.diff.toFixed(4), r.cls]));
        this.prepareExport(`sessions-${code}`, { headers: ["Date", "Rate", "Change", "Dir"], rows: data.rows.map(r => [r.date, r.value, r.diff, r.cls]) });
      } 
      else if (type === "stats") {
        const { rates, stats } = await this.analyzer.getStatistics(table, code, startStr, endStr);
        this.renderStats(code, stats);
        this.drawLineChart(rates, `${code} Rate`);
        this.renderTable(["Date", "Rate"], rates.map(r => [r.date, r.value]));
        this.prepareExport(`stats-${code}`, { headers: ["Date", "Rate"], rows: rates.map(r => [r.date, r.value]) });
      }
      else if (type === "gold") {
        const rates = await this.analyzer.nbpService.fetchGold(startStr, endStr);
        const stats = this.analyzer.analysisService.analyzeStats(rates);
        const sessions = this.analyzer.analysisService.analyzeSessions(rates);
        this.renderSessions("Gold", sessions);
        this.renderStats("Gold", stats);
        this.renderTable(["Date", "Price (PLN/g)"], rates.map(r => [r.date, r.value]));
        this.prepareExport("gold", { headers: ["Date", "Price"], rows: rates.map(r => [r.date, r.value]) });
      }
      else if (type === "distribution") {
        const distStart = this.els.startDate.value;
        const data = await this.analyzer.getDistribution(table, code, codeB, distStart, endStr, granularity);
        this.drawBarChart(data.bins, `${code}/${codeB} ${granularity} changes distribution`);
        this.renderTable(["Interval (%)", "Frequency"], data.bins.map(b => [`${b.from.toFixed(2)}% — ${b.to.toFixed(2)}%`, b.count]));
        this.prepareExport(`dist-${code}-${codeB}`, {headers: ["Period", "Change %"], rows: data.changes.map(c => [c.period, c.change])});
      }

      this.setStatus("Success.");
    } catch (e) {
      this.setStatus(e.message, true);
    } finally {
      this.els.runBtn.disabled = false;
    }
  }

  /**
   * Helper to render a data table in the results section.
   * @param {Array} headers - Table headers.
   * @param {Array} rows - Table body rows.
   */
  renderTable(headers, rows) {
    const html = `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    this.els.tableWrap.innerHTML = html;
  }

  initListeners() {
    this.els.runBtn.addEventListener("click", () => this.run());
    this.els.tableType.addEventListener("change", () => this.populateCurrencies());
    this.els.analysisType.addEventListener("change", () => this.updateFieldVisibility());
    this.els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => this.switchView(tab));
    });
    this.els.exportBtn.addEventListener("click", () => this.handleExport());
  }

  /**
   * Clears dynamic result elements before a new run.
   */
  clearResults() {
    document.querySelectorAll(".dyn").forEach((n) => n.remove());
    this.els.tableWrap.innerHTML = "";
    const ctx = this.els.chart.getContext("2d");
    ctx.clearRect(0, 0, this.els.chart.width, this.els.chart.height);
  }

  /**
   * Draws a line chart on the canvas.
   * @param {Array} rates - Data points to plot.
   * @param {string} label - Chart title.
   */
  drawLineChart(rates, label) {
    const c = this.els.chart;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = c.width = c.clientWidth * dpr;
    const H = c.height = 380 * dpr;

    const pad = { l: 60 * dpr, r: 20 * dpr, t: 40 * dpr, b: 40 * dpr };
    const vals = rates.map((r) => r.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const xStep = (W - pad.l - pad.r) / Math.max(1, rates.length - 1);
    const yScale = (v) => H - pad.b - ((v - min) / (max - min || 1)) * (H - pad.t - pad.b);

    // Grid and Labels
    ctx.strokeStyle = "#e2e8f0";
    ctx.fillStyle = "#64748b";
    ctx.font = `${12 * dpr}px sans-serif`;
    for (let i = 0; i <= 5; i++) {
      const y = pad.t + (i * (H - pad.t - pad.b)) / 5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const v = max - (i * (max - min)) / 5;
      ctx.fillText(v.toFixed(4), 4, y + 4);
    }

    // Line
    ctx.strokeStyle = "#b91c1c"; ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    rates.forEach((r, i) => {
      const x = pad.l + i * xStep;
      const y = yScale(r.value);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#0f172a"; ctx.font = `bold ${14 * dpr}px sans-serif`;
    ctx.fillText(label, pad.l, 20 * dpr);
  }

  /**
   * Draws a bar chart/histogram on the canvas.
   * @param {Array} bins - Data bins with {from, to, count}.
   * @param {string} label - Chart title.
   */
  drawBarChart(bins, label) {
    const c = this.els.chart;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = c.width = c.clientWidth * dpr;
    const H = c.height = 380 * dpr;

    const pad = { l: 50 * dpr, r: 20 * dpr, t: 40 * dpr, b: 50 * dpr };
    const maxC = Math.max(1, ...bins.map((b) => b.count));
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const bw = innerW / bins.length;

    ctx.clearRect(0, 0, W, H);

    bins.forEach((b, i) => {
      const h = (b.count / maxC) * innerH;
      const x = pad.l + i * bw + 4;
      const y = pad.t + innerH - h;
      
      // Color coding: Green for positive, Red for negative, Grey for neutral
      const color = b.from >= 0 ? "#16a34a" : (b.to <= 0 ? "#dc2626" : "#64748b");
      
      ctx.fillStyle = color;
      ctx.fillRect(x, y, bw - 8, h);
      
      // Values on top of bars
      ctx.fillStyle = "#0f172a";
      ctx.font = `bold ${10 * dpr}px sans-serif`;
      ctx.fillText(b.count, x + (bw/4), y - 5);

      // X Axis labels (ranges)
      ctx.fillStyle = "#64748b";
      ctx.font = `${9 * dpr}px sans-serif`;
      ctx.fillText(`${b.from.toFixed(1)}%`, x, H - 20 * dpr);
    });

    ctx.fillStyle = "#0f172a"; ctx.font = `bold ${14 * dpr}px sans-serif`;
    ctx.fillText(label, pad.l, 20 * dpr);
  }


  /**
   * Renders the session analysis dashboard.
   */
  renderSessions(code, data) {
    document.getElementById("resultsTitle").textContent = "Trading Session Analysis";
    const summary = document.createElement("div");
    summary.className = "session-summary dyn";
    summary.innerHTML = `
      <span class="chip up">Upward: <b>${data.up}</b></span>
      <span class="chip down">Downward: <b>${data.down}</b></span>
      <span class="chip flat">Unchanged: <b>${data.flat}</b></span>`;
    document.getElementById("meta").after(summary);

    this.drawBarChart([
      { from: 1, to: 2, count: data.up },
      { from: 0, to: 0, count: data.flat },
      { from: -2, to: -1, count: data.down }
    ], `Session Outcomes for ${code}`);
  }

  /**
   * Renders the statistical grid.
   */
  renderStats(code, stats) {
    document.getElementById("resultsTitle").textContent = "Statistical Measures";
    const grid = document.createElement("div");
    grid.className = "stat-grid dyn";
    const cards = [
      ["Median", stats.median.toFixed(4)],
      ["Mean", stats.mean.toFixed(4)],
      ["StdDev", stats.std.toFixed(4)],
      ["CV", `${stats.cv.toFixed(2)}%`]
    ];
    grid.innerHTML = cards.map(([k, v]) => `
      <div class="stat-card"><div class="k">${k}</div><div class="v">${v}</div></div>
    `).join("");
    document.getElementById("meta").after(grid);
  }
}

if (typeof module !== 'undefined') {
  module.exports = { NBPService, NBPServiceError, AnalysisService, CurrencyAnalyzer, CSVExporter };
}

// Only instantiate in the browser
if (typeof window !== 'undefined') {
  window.ui = new UIController();
}