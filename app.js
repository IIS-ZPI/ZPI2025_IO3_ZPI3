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
}

if (typeof module !== 'undefined') {
  module.exports = { NBPService, NBPServiceError, AnalysisService };
}