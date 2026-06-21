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
 * Service class to handle all communication with the NBP API.
 */
class NBPService {
  constructor() {
    this.baseUrl = "https://api.nbp.pl/api";
    this.MIN_DATE = "2002-01-02";
    this.GOLD_MIN_DATE = "2013-01-02";
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
    return json.rates.map((r) => ({
      date: r.effectiveDate,
      // For Table C, we calculate a mid-equivalent by averaging bid and ask
      value: r.mid != null ? r.mid : (r.bid + r.ask) / 2,
      bid: r.bid,
      ask: r.ask,
    }));
  }

  /**
   * Fetches gold prices for a given range.
   * @param {string} startDate - Range start.
   * @param {string} endDate - Range end.
   * @returns {Promise<Array>} Array of gold price objects.
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
    return json.map((r) => ({ date: r.data, value: r.cena }));
  }

  /**
   * Fetches data in chunks to bypass NBP API's 367-day limit.
   * @param {string} table - NBP table.
   * @param {string} code - Currency code.
   * @param {string} startStr - Start date.
   * @param {string} endStr - End date.
   * @returns {Promise<Array>} Deduplicated rates.
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

// Export for tests
if (typeof module !== 'undefined') {
  module.exports = { NBPService, NBPServiceError };
}