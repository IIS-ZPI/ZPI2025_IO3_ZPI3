/**
 * @jest-environment jsdom
 */

const { NBPService, NBPServiceError, AnalysisService, CurrencyAnalyzer, CSVExporter, UIController } = require('./app.js');

global.fetch = jest.fn();

describe('NBPService Class Tests', () => {
    let service;

    beforeEach(() => {
        service = new NBPService();
        fetch.mockClear();
    });

    test('formatDate should return YYYY-MM-DD', () => {
        const date = new Date('2022-05-15');
        expect(service.formatDate(date)).toBe('2022-05-15');
    });

    test('fetchRates should parse Table C bid/ask to a single mid value', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                rates: [{ effectiveDate: '2023-01-01', bid: 4.10, ask: 4.30 }]
            })
        });

        const data = await service.fetchRates('C', 'USD', '2023-01-01', '2023-01-01');
        expect(data[0].value).toBe(4.20); // Average of 4.1 and 4.3
    });

    test('fetchRates should throw NBPServiceError on 404', async () => {
        fetch.mockResolvedValue({ ok: false, status: 404 });
        
        try {
            await service.fetchRates('A', 'USD', '2000-01-01', '2000-01-01');
        } catch (error) {
            expect(error).toBeInstanceOf(NBPServiceError);
            expect(error.message).toContain('No data');
            expect(error.status).toBe(404);
        }
    });
});

describe('AnalysisService Session Tests', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new AnalysisService();
  });

  test('should correctly classify upward, downward, and flat sessions', () => {
    const rates = [
      { date: '2023-01-01', value: 4.50 },
      { date: '2023-01-02', value: 4.60 }, // Up
      { date: '2023-01-03', value: 4.40 }, // Down
      { date: '2023-01-04', value: 4.40 }  // Flat
    ];

    const result = analyzer.analyzeSessions(rates);

    expect(result.up).toBe(1);
    expect(result.down).toBe(1);
    expect(result.flat).toBe(1);
    expect(result.rows.length).toBe(3);
    expect(result.rows[0].cls).toBe('up');
    expect(result.rows[2].cls).toBe('flat');
  });

  test('should return empty results if only one session is provided', () => {
    const rates = [{ date: '2023-01-01', value: 4.50 }];
    const result = analyzer.analyzeSessions(rates);

    expect(result.up).toBe(0);
    expect(result.rows.length).toBe(0);
  });

  test('should handle all rates being equal (all flat)', () => {
    const rates = [
      { date: '2023-01-01', value: 4.0 },
      { date: '2023-01-02', value: 4.0 },
      { date: '2023-01-03', value: 4.0 }
    ];
    const result = analyzer.analyzeSessions(rates);
    expect(result.flat).toBe(2);
    expect(result.up).toBe(0);
    expect(result.down).toBe(0);
  });
});

describe('AnalysisService Statistical Measures Tests', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new AnalysisService();
  });

  test('median should correctly calculate for odd and even sets', () => {
    expect(analyzer.median([1, 5, 3])).toBe(3);
    expect(analyzer.median([1, 2, 3, 4])).toBe(2.5);
  });

  test('stddev should calculate mean and population standard deviation', () => {
    const result = analyzer.stddev([10, 10, 10]);
    expect(result.mean).toBe(10);
    expect(result.std).toBe(0);

    const diverse = analyzer.stddev([2, 4, 4, 4, 5, 5, 7, 9]);
    // Mean = 5, Variance = 4, StdDev = 2
    expect(diverse.mean).toBe(5);
    expect(diverse.std).toBe(2);
  });

  test('mode should find the most frequent rounded value', () => {
    const result = analyzer.mode([1.12344, 1.12341, 5.0, 1.12342]);
    // Since we group by .toFixed(4), 1.12344, 1.12341, 1.12342 all become "1.1234"
    expect(result.value).toBe(1.1234);
    expect(result.count).toBe(3);
  });

  test('analyzeStats should aggregate all measures correctly', () => {
    const rates = [
        { value: 10 }, { value: 20 }, { value: 30 }
    ];
    const report = analyzer.analyzeStats(rates);
    expect(report.mean).toBe(20);
    expect(report.median).toBe(20);
    expect(report.cv).toBeGreaterThan(0);
    expect(report.min).toBe(10);
    expect(report.max).toBe(30);
  });
});

describe('AnalysisService Distribution Analysis Tests', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new AnalysisService();
  });

  test('should synchronize dates and calculate correct cross-rates', () => {
    const ratesA = [
      { date: '2023-01-01', value: 4.0 }, 
      { date: '2023-01-02', value: 4.2 }
    ];
    const ratesB = [
      { date: '2023-01-02', value: 1.0 }, 
      { date: '2023-01-03', value: 1.1 }
    ];
    
    // Only 2023-01-02 is common. Cross rate = 4.2 / 1.0 = 4.2
    const result = analyzer.analyzeDistribution(ratesA, ratesB, 'monthly');
    // Result changes will be empty because we need at least 2 periods to calculate change
    expect(result.changes.length).toBe(0);
  });

  test('should correctly bin percentage changes into 10 intervals', () => {
    // Mocking 11 months of data to get 10 changes
    const ratesA = Array.from({length: 11}, (_, i) => ({
      date: `2023-${String(i+1).padStart(2, '0')}-01`,
      value: 10 + i // values: 10, 11, 12...
    }));
    const ratesB = ratesA.map(r => ({ date: r.date, value: 1 })); // Cross rate = value

    const result = analyzer.analyzeDistribution(ratesA, ratesB, 'monthly');
    
    expect(result.changes.length).toBe(10);
    expect(result.bins.length).toBe(10);
    // Total count in bins should equal number of changes
    const totalCount = result.bins.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBe(10);
  });
});

describe('CurrencyAnalyzer Integration Tests', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new CurrencyAnalyzer();
    global.fetch = jest.fn();
  });

  test('Full flow: getStatistics should fetch and analyze data', async () => {
    // Mock API response
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: [
          { effectiveDate: '2023-01-01', mid: 4.0 },
          { effectiveDate: '2023-01-02', mid: 5.0 }
        ]
      })
    });

    const result = await analyzer.getStatistics('A', 'USD', '2023-01-01', '2023-01-02');

    expect(result.rates.length).toBe(2);
    expect(result.stats.mean).toBe(4.5);
    expect(result.stats.max).toBe(5.0);
  });

  test('Full flow: getDistribution should handle parallel fetching and processing', async () => {
    // Mock two successful API calls
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ rates: [{ effectiveDate: '2023-01-01', mid: 4.0 }, { effectiveDate: '2023-02-01', mid: 4.4 }] })
    }).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ rates: [{ effectiveDate: '2023-01-01', mid: 1.0 }, { effectiveDate: '2023-02-01', mid: 1.0 }] })
    });

    const dist = await analyzer.getDistribution('A', 'USD', 'EUR', '2023-01-01', '2023-02-01', 'monthly');
    
    expect(dist.changes.length).toBe(1);
    expect(dist.changes[0].change).toBe(10); // 4.4/1.0 vs 4.0/1.0 = +10%
  });
});

describe('CSVExporter Tests', () => {
  let exporter;

  beforeEach(() => {
    exporter = new CSVExporter();
  });

  test('generateCSVString should format headers and rows correctly', () => {
    const headers = ["Date", "Value"];
    const rows = [
      ["2023-01-01", 4.50],
      ["2023-01-02", 4.60]
    ];

    const expected = `"Date","Value"\n"2023-01-01","4.5"\n"2023-01-02","4.6"`;
    const result = exporter.generateCSVString(headers, rows);

    expect(result).toBe(expected);
  });

  test('generateCSVString should escape double quotes within cells', () => {
    const headers = ["ID", "Comment"];
    const rows = [[1, 'This is a "quoted" comment']];

    const expected = `"ID","Comment"\n"1","This is a ""quoted"" comment"`;
    const result = exporter.generateCSVString(headers, rows);

    expect(result).toBe(expected);
  });
});

describe('End-to-End User Flow Simulation', () => {
  let ui;

  beforeEach(() => {
    // Mock Canvas getContext to prevent errors in JSDOM
    HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      clearRect: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      stroke: jest.fn(),
      fillText: jest.fn(),
      fillRect: jest.fn(),
    }));

    // Setup minimal DOM required for the controller
    document.body.innerHTML = `
      <select id="analysisType"><option value="stats">Stats</option></select>
      <select id="tableType"><option value="A">A</option></select>
      <select id="currency"></select><select id="currencyB"></select>
      <select id="period"><option value="30">30</option></select>
      <input type="date" id="startDate">
      <select id="distGran"><option value="monthly">Monthly</option></select>
      <button id="runBtn">Run</button><button id="exportBtn" disabled>Export</button>
      <div id="status"></div><div id="results" hidden>
        <div id="resultsTitle"></div><p id="meta"></p>
        <div class="tab" data-view="chart"></div><div class="tab" data-view="table"></div>
        <div id="chartWrap"></div><div id="tableWrap" hidden></div>
        <canvas id="chart"></canvas>
      </div>
      <div id="nbpTableWrap"></div><div id="currencyWrap"></div>
      <div id="currencyBWrap"></div><div id="startDateWrap"></div>
      <div id="distGranWrap"></div>
    `;
    
    global.fetch = jest.fn();
    ui = new UIController();
  });

  test('Flow: User selects currency, runs analysis, and views statistical results', async () => {
    // Mock API Success
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: [
          { effectiveDate: '2023-01-01', mid: 4.0 },
          { effectiveDate: '2023-01-02', mid: 4.2 }
        ]
      })
    });

    // EXECUTE: User clicks Run
    await ui.run();

    // VALIDATE: Results are visible and processed
    expect(ui.els.results.hidden).toBe(false);
    expect(ui.els.status.textContent).toBe('Success.');
    
    // Check if Statistical Cards were rendered
    const statCards = document.querySelectorAll('.stat-card');
    expect(statCards.length).toBeGreaterThan(0);
    
    // VALIDATE: Export button is now enabled
    expect(ui.els.exportBtn.disabled).toBe(false);
  });

  test('Flow: User toggles between Chart and Table views', () => {
    const chartTab = document.querySelector('.tab[data-view="chart"]');
    const tableTab = document.querySelector('.tab[data-view="table"]');

    // Default state: Chart visible, Table hidden
    expect(ui.els.chartWrap.hidden).toBe(false);
    expect(ui.els.tableWrap.hidden).toBe(true);

    // EXECUTE: Click Table tab
    ui.switchView(tableTab);

    // VALIDATE: Table visible, Chart hidden
    expect(ui.els.chartWrap.hidden).toBe(true);
    expect(ui.els.tableWrap.hidden).toBe(false);
  });
});