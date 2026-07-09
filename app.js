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
      if (res.status >= 500) {
        throw new NBPServiceError(`NBP API is currently unavailable (server error ${res.status}). Try again later.`, res.status);
      }
      throw new NBPServiceError(`NBP API error for ${code} (status ${res.status}).`, res.status);
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
   * Fetches the full list of currencies published in a given NBP table.
   * Used to populate the currency selectors dynamically (UC / S2-01).
   * @param {string} table - NBP table (A, B, or C).
   * @returns {Promise<Array<[string,string]>>} Array of [code, name] pairs.
   */
  async fetchCurrencyList(table) {
    const t = (table || "A").toLowerCase();
    const url = `${this.baseUrl}/exchangerates/tables/${t}/?format=json`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new NBPServiceError(`Cannot load currency list for table ${table} (status ${res.status}).`, res.status);
    }
    const json = await res.json();
    const rates = json && json[0] && Array.isArray(json[0].rates) ? json[0].rates : [];
    if (!rates.length) throw new NBPServiceError(`Empty currency list for table ${table}.`, 200);
    return rates.map((r) => [r.code, r.currency]);
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
      if (res.status >= 500) {
        throw new NBPServiceError(`NBP API is currently unavailable (server error ${res.status}). Try again later.`, res.status);
      }
      throw new NBPServiceError(`NBP API error for gold prices (status ${res.status}).`, res.status);
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
   * Now also returns the percentage share of each outcome (S1-07/08/09, S2-07).
   *
   * @param {Array} rates - Array of rate objects {date, value}.
   * @returns {Object} Counts (up/down/flat), their percentages, total and detailed rows.
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
        diff: this.round(diff),
        cls: cls
      });
    }

    const total = up + down + flat;
    const pct = (n) => (total ? this.round((n / total) * 100) : 0);

    return {
      up, down, flat, total,
      upPct: pct(up),
      downPct: pct(down),
      flatPct: pct(flat),
      rows
    };
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
 * Implements UC-001, UC-002, and UC-003 (plus gold analysis).
 */
class CurrencyAnalyzer {
  constructor() {
    this.nbpService = new NBPService();
    this.analysisService = new AnalysisService();
  }

  /**
   * UC-001: Orchestrates the analysis of trading sessions.
   * Returns both the raw rates (for the current-rate bar) and the session summary.
   */
  async getSessionAnalysis(table, code, startDate, endDate) {
    const rates = await this.nbpService.fetchRates(table, code, startDate, endDate);
    if (rates.length < 2) throw new Error("Not enough data points for session analysis.");
    return { rates, sessions: this.analysisService.analyzeSessions(rates) };
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
    if (!startDate || startDate < this.nbpService.MIN_DATE) {
      throw new Error(`Start date must be on or after ${this.nbpService.MIN_DATE}.`);
    }

    // Parallel fetching for performance
    const [ratesA, ratesB] = await Promise.all([
      this.nbpService.fetchRangeChunked(table, codeA, startDate, endDate),
      this.nbpService.fetchRangeChunked(table, codeB, startDate, endDate)
    ]);

    const distribution = this.analysisService.analyzeDistribution(ratesA, ratesB, granularity);
    if (!distribution.changes.length) throw new Error("Not enough data to compute distribution changes.");

    return distribution;
  }

  /**
   * Gold analysis: sessions + statistics on the gold price series.
   * Validates the gold-specific minimum date (2013-01-02).
   */
  async getGoldAnalysis(startDate, endDate) {
    if (!startDate || startDate < this.nbpService.GOLD_MIN_DATE) {
      throw new Error(`Gold prices are available from ${this.nbpService.GOLD_MIN_DATE}.`);
    }
    const rates = await this.nbpService.fetchGold(startDate, endDate);
    if (rates.length < 2) throw new Error("Not enough gold price data for analysis.");
    return {
      rates,
      stats: this.analysisService.analyzeStats(rates),
      sessions: this.analysisService.analyzeSessions(rates)
    };
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseFilename}-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
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
      resultsTitle: document.getElementById("resultsTitle"),
      meta: document.getElementById("meta"),
      currentRateBar: document.getElementById("currentRateBar"),
      dashboard: document.getElementById("dashboard"),
      legend: document.getElementById("legend"),
      tabs: document.querySelectorAll(".tab"),
      chart: document.getElementById("chart"),
      chartWrap: document.getElementById("chartWrap"),
      tooltip: document.getElementById("chartTooltip"),
      tableWrap: document.getElementById("tableWrap"),
      nbpTableWrap: document.getElementById("nbpTableWrap"),
      currencyWrap: document.getElementById("currencyWrap")
    };

    // Fallback lists (used offline or if the NBP table endpoint fails).
    this.FALLBACK = {
      A: [
        ["USD","US Dollar"],["EUR","Euro"],["GBP","British Pound"],["CHF","Swiss Franc"],
        ["JPY","Japanese Yen"],["CZK","Czech Koruna"],["SEK","Swedish Krona"],
        ["NOK","Norwegian Krone"],["DKK","Danish Krone"],["CAD","Canadian Dollar"],
        ["AUD","Australian Dollar"],["HUF","Hungarian Forint"],["CNY","Chinese Yuan"],
        ["UAH","Ukrainian Hryvnia"],["TRY","Turkish Lira"]
      ],
      B: [
        ["BGN","Bulgarian Lev"],["BRL","Brazilian Real"],["INR","Indian Rupee"],
        ["MXN","Mexican Peso"],["ZAR","South African Rand"],["IDR","Indonesian Rupiah"],
        ["KRW","South Korean Won"],["RON","Romanian Leu"],["THB","Thai Baht"],
        ["VND","Vietnamese Dong"],["PHP","Philippine Peso"]
      ],
      C: [
        ["USD","US Dollar"],["EUR","Euro"],["GBP","British Pound"],["CHF","Swiss Franc"]
      ]
    };

    this.validCodes = new Set();
    this._hist = null; // histogram geometry for tooltips

    this.analyzer = new CurrencyAnalyzer();
    this.exporter = new CSVExporter();
    this.lastExportData = null;

    this.initListeners();
    this.populateCurrencies();
    this.setDefaultDates();
    this.updateFieldVisibility();
  }

  /**
   * Sets the default start date and constraints (enforces the 2002-01-02 minimum).
   */
  setDefaultDates() {
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(today.getFullYear() - 1);

    if (this.els.startDate) {
      this.els.startDate.value = oneYearAgo.toISOString().slice(0, 10);
      this.els.startDate.min = this.analyzer.nbpService.MIN_DATE;
      this.els.startDate.max = today.toISOString().slice(0, 10);
    }
  }

  /**
   * Fills both currency <select> elements from a [code, name] list.
   * Preserves the previously-selected code if it still exists in the new list.
   */
  fillCurrencyOptions(list, defaultA, defaultB) {
    this.validCodes = new Set(list.map(([code]) => code));

    const build = (select, preferredCode) => {
      if (!select) return;
      const prevVal = select.value;
      select.innerHTML = "";
      for (const [code, name] of list) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = `${code} — ${name}`;
        select.appendChild(opt);
      }
      // Restore previous selection if still valid, else use preferred default
      if (prevVal && this.validCodes.has(prevVal)) {
        select.value = prevVal;
      } else if (preferredCode && this.validCodes.has(preferredCode)) {
        select.value = preferredCode;
      } else if (list.length) {
        select.value = list[0][0];
      }
    };

    build(this.els.currency, defaultA || "EUR");
    build(this.els.currencyB, defaultB || "USD");

    this.preventDuplicateSelection(); 
  }

  /**
   * Populates the currency selectors. Tries the live NBP table endpoint first
   * (S2-01: list from NBP API), falling back to the built-in list on failure.
   */
  async populateCurrencies() {
    const t = this.els.tableType ? this.els.tableType.value : "A";
    // 1. Seed synchronously from the fallback so the UI is usable immediately.
    this.fillCurrencyOptions(this.FALLBACK[t] || this.FALLBACK.A);
    // 2. Try to enrich from the live API.
    try {
      const list = await this.analyzer.nbpService.fetchCurrencyList(t);
      if (list && list.length) this.fillCurrencyOptions(list);
    } catch (_e) {
      // Keep fallback silently; offline or endpoint hiccup is non-fatal.
    }
  }

  /**
   * Extracts and validates a 3-letter currency code from a selector value
   * such as "USD — US Dollar" or a raw "USD".
   * @returns {string} Upper-case code, or "" if not recognised.
   */
  parseCode(value) {
    if (!value) return "";
    const head = String(value).split("—")[0].trim().toUpperCase();
    const m = head.match(/^[A-Z]{3}$/);
    if (m && (this.validCodes.size === 0 || this.validCodes.has(head))) return head;
    // try matching by name if the user typed a full country/currency name
    return "";
  }

  isKnownCurrency(value) {
    return this.parseCode(value) !== "";
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
   * Captures the current analysis results for export.
   */
  prepareExport(title, exportData) {
    this.lastExportData = { title, ...exportData };
    this.els.exportBtn.disabled = false;
  }

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

    const type = this.els.analysisType.value;
    const table = this.els.tableType.value;

    const endDate = new Date();
    const startDate = new Date();
    const periodDays = parseInt(this.els.period.value, 10);
    startDate.setDate(endDate.getDate() - periodDays);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    try {
      this.els.results.hidden = false;
      this.els.runBtn.disabled = true;
      this.showSkeleton();
      this.setStatus("Fetching data from NBP API…");

      if (type === "sessions") {
        const code = this.requireCode(this.els.currency.value);
        const { rates, sessions } = await this.analyzer.getSessionAnalysis(table, code, startStr, endStr);
        this.clearSkeleton();
        this.setMeta(`${code} · table ${table} · last ${periodDays} days · ${sessions.total} sessions`);
        this.renderCurrentRateBar(rates, `${code} / PLN`);
        this.renderSessions(code, sessions);
        this.renderTable(["Date", "Rate", "Change", "%", "Direction"],
          sessions.rows.map(r => [r.date, r.value, r.diff.toFixed(4),
            r.cls === "up" ? "▲" : r.cls === "down" ? "▼" : "•", r.cls]));
        this.prepareExport(`sessions-${code}`,
          { headers: ["Date", "Rate", "Change", "Dir"], rows: sessions.rows.map(r => [r.date, r.value, r.diff, r.cls]) });
      }
      else if (type === "stats") {
        const code = this.requireCode(this.els.currency.value);
        const { rates, stats } = await this.analyzer.getStatistics(table, code, startStr, endStr);
        this.clearSkeleton();
        this.setMeta(`${code} · table ${table} · last ${periodDays} days · ${stats.count} observations`);
        this.renderCurrentRateBar(rates, `${code} / PLN`);
        this.renderStats(code, stats);
        this.drawLineChart(rates, `${code} / PLN exchange rate`);
        this.renderTable(["Date", "Rate"], rates.map(r => [r.date, r.value]));
        this.prepareExport(`stats-${code}`,
          { headers: ["Date", "Rate"], rows: rates.map(r => [r.date, r.value]) });
      }
      else if (type === "gold") {
        const { rates, stats, sessions } = await this.analyzer.getGoldAnalysis(startStr, endStr);
        this.clearSkeleton();
        this.setMeta(`Gold (PLN/g) · last ${periodDays} days · ${stats.count} observations`);
        this.renderCurrentRateBar(rates, "Gold · PLN/g");
        this.renderSessions("Gold", sessions);
        this.renderStats("Gold", stats);
        this.drawLineChart(rates, "Gold price (PLN / g)");
        this.renderTable(["Date", "Price (PLN/g)"], rates.map(r => [r.date, r.value]));
        this.prepareExport("gold",
          { headers: ["Date", "Price"], rows: rates.map(r => [r.date, r.value]) });
      }
      else if (type === "distribution") {
        const code = this.requireCode(this.els.currency.value);
        const codeB = this.requireCode(this.els.currencyB.value);
        const granularity = this.els.distGran ? this.els.distGran.value : "monthly";
        const distStart = this.els.startDate.value;
        const data = await this.analyzer.getDistribution(table, code, codeB, distStart, endStr, granularity);
        this.clearSkeleton();
        this.setMeta(`${code}/${codeB} · ${granularity} changes · ${data.changes.length} observations`);
        this.drawBarChart(data.bins, `${code}/${codeB} ${granularity} change distribution`);
        this.renderTable(["Interval (%)", "Frequency"],
          data.bins.map(b => [`${b.from.toFixed(2)}% — ${b.to.toFixed(2)}%`, b.count]));
        this.prepareExport(`dist-${code}-${codeB}`,
          { headers: ["Period", "Change %"], rows: data.changes.map(c => [c.period, c.change]) });
      }

      this.setStatus("Done.");
    } catch (e) {
      this.clearSkeleton();
      this.setStatus(e.message, true);
    } finally {
      this.els.runBtn.disabled = false;
    }
  }

  /**
   * Reads and validates a currency code from a selector value, throwing a
   * user-facing error if it is not a recognised code (S2-05 validation).
   */
  requireCode(value) {
    const code = this.parseCode(value);
    if (!code) throw new Error(`"${(value || "").trim() || "—"}" is not a valid currency. Pick one from the list.`);
    return code;
  }

  setMeta(text) {
    if (this.els.meta) {
      const parts = text.split(" · ");
      this.els.meta.innerHTML = parts.map(p => `<span class="meta-badge">${p}</span>`).join("");
    }
  }

  renderTable(headers, rows) {
    const html = `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    this.els.tableWrap.innerHTML = html;
  }

  preventDuplicateSelection() {
    if (!this.els.currency || !this.els.currencyB) 
      return;

    const selectedA = this.els.currency.value;
    Array.from(this.els.currencyB.options).forEach(opt => {
      opt.disabled = (opt.value === selectedA);
    });
    
    if (this.els.currencyB.value === selectedA) {
      this.els.currencyB.selectedIndex = (this.els.currency.selectedIndex + 1) % this.els.currencyB.options.length;
    }
  }

  initListeners() {
    this.els.runBtn.addEventListener("click", () => this.run());
    this.els.tableType.addEventListener("change", () => this.populateCurrencies());
    this.els.analysisType.addEventListener("change", () => this.updateFieldVisibility());
    this.els.currency.addEventListener("change", () => this.preventDuplicateSelection());
    this.els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => this.switchView(tab));
    });
    this.els.exportBtn.addEventListener("click", () => this.handleExport());

    // Histogram hover tooltips (S2-10 interactivity).
    if (this.els.chart) {
      this.els.chart.addEventListener("mousemove", (e) => this.handleChartHover(e));
      this.els.chart.addEventListener("mouseleave", () => this.hideTooltip());
    }
  }

  clearResults() {
    if (this.els.currentRateBar) { this.els.currentRateBar.hidden = true; this.els.currentRateBar.innerHTML = ""; }
    if (this.els.dashboard) this.els.dashboard.innerHTML = "";
    if (this.els.legend) { this.els.legend.hidden = true; this.els.legend.innerHTML = ""; }
    if (this.els.tableWrap) this.els.tableWrap.innerHTML = "";
    this.hideTooltip();
    this._hist = null;
    this.lastExportData = null;
    if (this.els.exportBtn) this.els.exportBtn.disabled = true;
    if (this.els.chart) {
      const ctx = this.els.chart.getContext("2d");
      ctx.clearRect(0, 0, this.els.chart.width, this.els.chart.height);
    }
    // Reset to chart tab so results panel always starts on the chart view
    this.els.tabs.forEach((t) => t.classList.remove("active"));
    const chartTab = [...this.els.tabs].find((t) => t.dataset.view === "chart");
    if (chartTab) chartTab.classList.add("active");
    if (this.els.chartWrap) this.els.chartWrap.hidden = false;
    if (this.els.tableWrap) this.els.tableWrap.hidden = true;
  }

  /* ---------------- loading skeleton (S2-13) ---------------- */

  showSkeleton() {
    if (!this.els.dashboard) return;
    this.els.dashboard.innerHTML = Array.from({ length: 4 })
      .map(() => `<div class="skeleton-card"><div class="sk-line sk-sm"></div><div class="sk-line sk-lg"></div></div>`)
      .join("");
  }

  clearSkeleton() {
    if (this.els.dashboard) this.els.dashboard.innerHTML = "";
  }

  /* ---------------- current rate bar (S2-06) ---------------- */

  renderCurrentRateBar(rates, unitLabel) {
    const bar = this.els.currentRateBar;
    if (!bar) return;
    if (!rates || rates.length === 0) { bar.hidden = true; return; }

    const last = rates[rates.length - 1];
    const prev = rates.length > 1 ? rates[rates.length - 2] : null;
    const delta = prev ? last.value - prev.value : 0;
    const pct = prev && prev.value ? (delta / prev.value) * 100 : 0;
    const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "▬";

    bar.className = `rate-bar ${dir}`;
    bar.hidden = false;
    bar.innerHTML = `
      <div class="rate-main">
        <span class="rate-label">${unitLabel}</span>
        <span class="rate-value">${last.value.toFixed(4)}</span>
      </div>
      <div class="rate-change ${dir}">
        <span class="rate-arrow">${arrow}</span>
        <span class="rate-delta">${delta > 0 ? "+" : ""}${delta.toFixed(4)} (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)</span>
        <span class="rate-sub">vs previous session · ${last.date}</span>
      </div>`;
  }

  /* ---------------- charts ---------------- */

  /**
   * Sizes the canvas backing store to match its CONTAINER, and pins an explicit
   * @param {number} [heightCss=380] Canvas height in CSS pixels.
   * @returns {{W:number,H:number,dpr:number}} Device-pixel dimensions.
   */
  resizeCanvas(heightCss = 380) {
    const c = this.els.chart;
    const dpr = window.devicePixelRatio || 1;
    const host = this.els.chartWrap || c;
    const cssW = Math.max(1, Math.floor(host.clientWidth || c.clientWidth || 900));
    c.style.width = cssW + "px";
    c.style.height = heightCss + "px";
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(heightCss * dpr);
    return { W: c.width, H: c.height, dpr };
  }

  drawLineChart(rates, label) {
    const c = this.els.chart;
    const ctx = c.getContext("2d");
    const { W, H, dpr } = this.resizeCanvas();

    const pad = { l: 60 * dpr, r: 20 * dpr, t: 40 * dpr, b: 40 * dpr };
    const vals = rates.map((r) => r.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const xStep = (W - pad.l - pad.r) / Math.max(1, rates.length - 1);
    const yScale = (v) => H - pad.b - ((v - min) / (max - min || 1)) * (H - pad.t - pad.b);

    ctx.strokeStyle = "#e2e8f0";
    ctx.fillStyle = "#64748b";
    ctx.font = `${12 * dpr}px sans-serif`;
    for (let i = 0; i <= 5; i++) {
      const y = pad.t + (i * (H - pad.t - pad.b)) / 5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const v = max - (i * (max - min)) / 5;
      ctx.fillText(v.toFixed(4), 4, y + 4);
    }

    ctx.strokeStyle = "#b91c1c"; ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    rates.forEach((r, i) => {
      const x = pad.l + i * xStep;
      const y = yScale(r.value);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // x-axis labels (a few evenly spaced dates)
    const labelCount = Math.min(6, rates.length);
    ctx.fillStyle = "#64748b"; ctx.font = `${11 * dpr}px sans-serif`;
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i * (rates.length - 1)) / Math.max(1, labelCount - 1));
      const x = pad.l + idx * xStep;
      ctx.fillText(rates[idx].date, x - 28 * dpr, H - 12 * dpr);
    }

    ctx.fillStyle = "#0f172a"; ctx.font = `bold ${14 * dpr}px sans-serif`;
    ctx.fillText(label, pad.l, 20 * dpr);
  }

  /**
   * Draws the change-distribution histogram and stores geometry so that
   * hover tooltips can map cursor position back to a bin (S2-10).
   * Redesigned for non-expert readability: plain-language labels, color legend,
   * directional zero-line, "Most common" callout, and non-rotated x-axis ticks.
   */
  drawBarChart(bins, label) {
    const c = this.els.chart;
    const ctx = c.getContext("2d");
    const { W, H, dpr } = this.resizeCanvas(440);

    // Wider left padding for y-axis label; extra top for title+subtitle+legend
    const padCss = { l: 68, r: 20, t: 88, b: 50 };
    const pad = { l: padCss.l * dpr, r: padCss.r * dpr, t: padCss.t * dpr, b: padCss.b * dpr };
    const maxC = Math.max(1, ...bins.map((b) => b.count));
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const bw = innerW / bins.length;
    const mText = (s) => ctx.measureText ? ctx.measureText(s).width : s.length * 6 * dpr;

    ctx.clearRect(0, 0, W, H);

    // ── Title + subtitle ────────────────────────────────────────────────────
    ctx.fillStyle = "#0f172a"; ctx.font = `bold ${14 * dpr}px sans-serif`;
    ctx.fillText(label, pad.l, 22 * dpr);
    ctx.fillStyle = "#64748b"; ctx.font = `${10.5 * dpr}px sans-serif`;
    ctx.fillText("Each circle shows how many months the exchange rate changed by that amount.", pad.l, 40 * dpr);

    // ── Color legend (top-right) ────────────────────────────────────────────
    const legends = [
      { color: "#dc2626", text: "Rate fell" },
      { color: "#64748b", text: "Mixed / near zero" },
      { color: "#16a34a", text: "Rate rose" },
    ];
    let lx = W - padCss.r * dpr;
    ctx.font = `${10 * dpr}px sans-serif`;
    for (let li = legends.length - 1; li >= 0; li--) {
      const item = legends[li];
      const tw = mText(item.text);
      lx -= tw + 6 * dpr;
      ctx.fillStyle = "#475569"; ctx.fillText(item.text, lx, 22 * dpr);
      lx -= 14 * dpr;
      ctx.beginPath(); ctx.arc(lx + 6 * dpr, 18 * dpr, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = item.color; ctx.fill();
      lx -= 12 * dpr;
    }

    // ── Y-axis label "Months" (rotated) ────────────────────────────────────
    ctx.save();
    ctx.fillStyle = "#64748b"; ctx.font = `${10 * dpr}px sans-serif`;
    ctx.translate(14 * dpr, pad.t + innerH / 2);
    ctx.rotate(-Math.PI / 2);
    const yLabelStr = "Months";
    ctx.fillText(yLabelStr, -mText(yLabelStr) / 2, 0);
    ctx.restore();

    // ── Y grid + integer ticks ──────────────────────────────────────────────
    const tickCount = Math.min(5, maxC);
    ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 1 * dpr;
    ctx.fillStyle = "#94a3b8"; ctx.font = `${10 * dpr}px sans-serif`;
    for (let i = 0; i <= tickCount; i++) {
      const y = pad.t + (i * innerH) / tickCount;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const v = Math.round(maxC - (i * maxC) / tickCount);
      const vStr = String(v);
      ctx.fillText(vStr, pad.l - mText(vStr) - 6 * dpr, y + 4 * dpr);
    }

    // ── X baseline ─────────────────────────────────────────────────────────
    ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t + innerH); ctx.lineTo(W - pad.r, pad.t + innerH); ctx.stroke();

    // ── Zero-line with directional labels ──────────────────────────────────
    const minV = bins[0].from, maxV = bins[bins.length - 1].to;
    if (minV < 0 && maxV > 0) {
      const zx = pad.l + ((0 - minV) / (maxV - minV)) * innerW;
      ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([5 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(zx, pad.t); ctx.lineTo(zx, pad.t + innerH); ctx.stroke();
      ctx.setLineDash([]);
      // Directional arrows above the chart area
      ctx.fillStyle = "#dc2626"; ctx.font = `bold ${9 * dpr}px sans-serif`;
      ctx.fillText("← fell", zx - mText("← fell") - 6 * dpr, pad.t - 8 * dpr);
      ctx.fillStyle = "#16a34a";
      ctx.fillText("rose →", zx + 6 * dpr, pad.t - 8 * dpr);
      // "no change" label on baseline
      ctx.fillStyle = "#94a3b8"; ctx.font = `${9 * dpr}px sans-serif`;
      const ncW = mText("no change");
      ctx.fillText("no change", zx - ncW / 2, pad.t + innerH - 4 * dpr);
    }

    // ── Lollipops ───────────────────────────────────────────────────────────
    const R = Math.min(bw * 0.3, 20 * dpr);
    const modeIdx = bins.reduce((best, b, i) => b.count > bins[best].count ? i : best, 0);

    bins.forEach((b, i) => {
      const cx = pad.l + (i + 0.5) * bw;
      const baseY = pad.t + innerH;
      const color = b.from >= 0 ? "#16a34a" : (b.to <= 0 ? "#dc2626" : "#64748b");

      if (b.count === 0) {
        ctx.beginPath(); ctx.arc(cx, baseY, 3 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = "#e2e8f0"; ctx.fill();
      } else {
        const stemTop = pad.t + innerH - (b.count / maxC) * innerH;

        // Stem
        ctx.strokeStyle = color; ctx.lineWidth = 2.5 * dpr;
        ctx.beginPath(); ctx.moveTo(cx, baseY); ctx.lineTo(cx, stemTop + R); ctx.stroke();

        // Circle
        ctx.beginPath(); ctx.arc(cx, stemTop, R, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * dpr; ctx.stroke();

        // Count inside circle
        const countStr = String(b.count);
        const fontSize = Math.max(9, Math.min(13, Math.floor(R * 0.85 / dpr))) * dpr;
        ctx.fillStyle = "#fff"; ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillText(countStr, cx - mText(countStr) / 2, stemTop + fontSize * 0.36);

        // "Most common" callout on the tallest bin
        if (i === modeIdx && maxC > 1) {
          ctx.fillStyle = "#0f172a"; ctx.font = `${9 * dpr}px sans-serif`;
          const tag = "most common";
          const tw = mText(tag);
          const tx = Math.max(pad.l, Math.min(W - pad.r - tw, cx - tw / 2));
          ctx.fillText(tag, tx, stemTop - R - 6 * dpr);
        }
      }

      // X-axis % label — non-rotated, centered, larger bins get cleaner labels
      const pct = `${b.from.toFixed(1)}%`;
      ctx.fillStyle = b.count > 0 ? "#475569" : "#cbd5e1";
      ctx.font = `${9 * dpr}px sans-serif`;
      ctx.fillText(pct, cx - mText(pct) / 2, baseY + 16 * dpr);
    });

    // ── X-axis unit label ───────────────────────────────────────────────────
    ctx.fillStyle = "#94a3b8"; ctx.font = `${10 * dpr}px sans-serif`;
    const xTitle = "Monthly change (%)";
    ctx.fillText(xTitle, pad.l + innerW / 2 - mText(xTitle) / 2, H - 6 * dpr);

    this._hist = { bins, padL: padCss.l, padR: padCss.r };
  }

  handleChartHover(e) {
    if (!this._hist || !this.els.tooltip) return;
    const rect = this.els.chart.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const innerW = rect.width - this._hist.padL - this._hist.padR;
    if (innerW <= 0) return;
    const bw = innerW / this._hist.bins.length;
    const idx = Math.floor((x - this._hist.padL) / bw);
    if (idx < 0 || idx >= this._hist.bins.length) { this.hideTooltip(); return; }
    const b = this._hist.bins[idx];
    const dir = b.from < 0 && b.to <= 0 ? "fell" : (b.from >= 0 ? "rose" : "crossed 0%");
    const monthWord = b.count === 1 ? "month" : "months";
    this.els.tooltip.innerHTML =
      `<b>${b.count} ${monthWord}</b> the rate <b>${dir}</b> between <b>${Math.abs(b.from).toFixed(1)}%</b> and <b>${Math.abs(b.to).toFixed(1)}%</b>`;
    this.els.tooltip.style.left = `${x + 12}px`;
    this.els.tooltip.style.top = `${e.clientY - rect.top + 12}px`;
    this.els.tooltip.hidden = false;
  }

  hideTooltip() {
    if (this.els.tooltip) this.els.tooltip.hidden = true;
  }

  /* ---------------- session dashboard (S2-07 / S2-08) ---------------- */

  renderSessions(code, data) {
    if (this.els.resultsTitle) this.els.resultsTitle.textContent =
      code === "Gold" ? "Gold — Sessions & Statistics" : "Trading Session Analysis";

    const items = [
      { key: "up",   label: "Upward",    count: data.up,   pct: data.upPct   },
      { key: "flat", label: "Unchanged", count: data.flat, pct: data.flatPct },
      { key: "down", label: "Downward",  count: data.down, pct: data.downPct },
    ];

    if (this.els.dashboard) {
      const cards = items.map(it => `
        <div class="session-card ${it.key}">
          <div class="sc-top"><span class="sc-dot"></span><span class="sc-label">${it.label}</span></div>
          <div class="sc-count">${it.count}</div>
          <div class="sc-pct">${it.pct.toFixed(1)}%</div>
        </div>`).join("");
      // append (do not overwrite) so gold can show sessions + stats together
      this.els.dashboard.insertAdjacentHTML("beforeend", `<div class="session-summary">${cards}</div>`);
    }

    this.drawSessionChart(items, `Session outcomes — ${code}`);
  }

  drawSessionChart(items, label) {
    const c = this.els.chart;
    if (!c) return;
    const ctx = c.getContext("2d");
    const { W, H, dpr } = this.resizeCanvas(320);

    ctx.clearRect(0, 0, W, H);

    const total = items.reduce((sum, it) => sum + it.count, 0);
    if (total === 0) return;

    const centerX = W / 2;
    const centerY = (H / 2) + 10 * dpr;
    const radius = Math.min(W, H) / 2 - 30 * dpr;
    const innerRadius = radius * 0.6;

    const swatch = { up: "#10b981", flat: "#94a3b8", down: "#f43f5e" };
    
    let startAngle = -Math.PI / 2;

    items.forEach((it) => {
      if (it.count === 0) return;
      const sliceAngle = (it.count / total) * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, startAngle, endAngle);
      ctx.arc(centerX, centerY, innerRadius, endAngle, startAngle, true);
      ctx.closePath();
      
      ctx.fillStyle = swatch[it.key];
      ctx.fill();

      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      // Add label for slices that are large enough
      if (sliceAngle > 0.15) {
        const midAngle = startAngle + sliceAngle / 2;
        const labelRadius = radius + 15 * dpr;
        const lx = centerX + Math.cos(midAngle) * labelRadius;
        const ly = centerY + Math.sin(midAngle) * labelRadius;
        
        ctx.fillStyle = "#0f172a";
        ctx.font = `bold ${12 * dpr}px sans-serif`;
        ctx.textAlign = Math.cos(midAngle) >= 0 ? "left" : "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`${it.count} (${it.pct.toFixed(0)}%)`, lx, ly);
      }

      startAngle = endAngle;
    });

    // Center text
    ctx.fillStyle = "#0f172a"; 
    ctx.font = `bold ${28 * dpr}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(total, centerX, centerY - 8 * dpr);
    
    ctx.fillStyle = "#64748b"; 
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.fillText("Sessions", centerX, centerY + 16 * dpr);

    // Title
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#0f172a"; ctx.font = `bold ${14 * dpr}px sans-serif`;
    ctx.fillText(label, 60 * dpr, 20 * dpr);

    this._hist = null;
  }

  /* ---------------- statistics cards (S2-09) ---------------- */

  renderStats(code, stats) {
    if (this.els.resultsTitle && code !== "Gold") this.els.resultsTitle.textContent = "Statistical Measures";

    const cards = [
      ["◧", "Median", stats.median.toFixed(4)],
      ["≡", "Mode", `${stats.mode.value.toFixed(4)} (×${stats.mode.count})`],
      ["σ", "Std. deviation", stats.std.toFixed(4)],
      ["%", "Coeff. of variation", `${stats.cv.toFixed(2)}%`],
      ["µ", "Mean", stats.mean.toFixed(4)],
      ["↕", "Min / Max", `${stats.min.toFixed(4)} / ${stats.max.toFixed(4)}`],
    ];
    const html = `<div class="stat-grid">${cards.map(([icon, k, v]) => `
      <div class="stat-card">
        <div class="stat-icon">${icon}</div>
        <div class="k">${k}</div>
        <div class="v">${v}</div>
      </div>`).join("")}</div>`;

    if (this.els.dashboard) this.els.dashboard.insertAdjacentHTML("beforeend", html);
  }
}

if (typeof module !== 'undefined') {
  module.exports = { NBPService, NBPServiceError, AnalysisService, CurrencyAnalyzer, CSVExporter, UIController };
}

// Only instantiate in the browser
if (typeof window !== 'undefined' && typeof process === 'undefined') {
  window.ui = new UIController();
}
