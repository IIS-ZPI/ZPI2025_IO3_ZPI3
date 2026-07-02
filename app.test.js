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

        await expect(service.fetchRates('A', 'USD', '2000-01-01', '2000-01-01'))
            .rejects.toBeInstanceOf(NBPServiceError);
    });

    test('fetchRates should surface a friendly message on 5xx', async () => {
        fetch.mockResolvedValue({ ok: false, status: 503 });
        try {
            await service.fetchRates('A', 'USD', '2023-01-01', '2023-01-02');
        } catch (error) {
            expect(error).toBeInstanceOf(NBPServiceError);
            expect(error.status).toBe(503);
            expect(error.message).toMatch(/unavailable/i);
        }
    });

    test('fetchCurrencyList should map the NBP table payload to [code, name] pairs', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve([{
                table: 'A',
                rates: [
                    { currency: 'US Dollar', code: 'USD', mid: 4.0 },
                    { currency: 'Euro', code: 'EUR', mid: 4.3 }
                ]
            }])
        });
        const list = await service.fetchCurrencyList('A');
        expect(list).toEqual([['USD', 'US Dollar'], ['EUR', 'Euro']]);
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

  test('should compute the percentage share of each outcome (S2-07)', () => {
    const rates = [
      { date: '2023-01-01', value: 4.0 },
      { date: '2023-01-02', value: 4.1 }, // up
      { date: '2023-01-03', value: 4.2 }, // up
      { date: '2023-01-04', value: 4.1 }, // down
      { date: '2023-01-05', value: 4.1 }  // flat
    ];
    const result = analyzer.analyzeSessions(rates);
    expect(result.total).toBe(4);
    expect(result.upPct).toBe(50);
    expect(result.downPct).toBe(25);
    expect(result.flatPct).toBe(25);
  });

  test('should return empty results if only one session is provided', () => {
    const rates = [{ date: '2023-01-01', value: 4.50 }];
    const result = analyzer.analyzeSessions(rates);

    expect(result.up).toBe(0);
    expect(result.rows.length).toBe(0);
    expect(result.upPct).toBe(0);
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
    expect(result.flatPct).toBe(100);
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
    expect(report.mode.value).toBeDefined();
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

  test('Full flow: getSessionAnalysis returns rates and session summary', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: [
          { effectiveDate: '2023-01-01', mid: 4.0 },
          { effectiveDate: '2023-01-02', mid: 4.2 }
        ]
      })
    });
    const result = await analyzer.getSessionAnalysis('A', 'USD', '2023-01-01', '2023-01-02');
    expect(result.rates.length).toBe(2);
    expect(result.sessions.up).toBe(1);
    expect(result.sessions.upPct).toBe(100);
  });

  test('Full flow: getDistribution should handle parallel fetching and processing', async () => {
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

  test('getDistribution should reject start dates before 2002-01-02 (S1-04/S2-05)', async () => {
    await expect(
      analyzer.getDistribution('A', 'USD', 'EUR', '2001-06-01', '2005-01-01', 'monthly')
    ).rejects.toThrow(/2002-01-02/);
  });

  test('getDistribution should reject identical currencies', async () => {
    await expect(
      analyzer.getDistribution('A', 'USD', 'USD', '2020-01-01', '2021-01-01', 'monthly')
    ).rejects.toThrow(/different currencies/i);
  });

  test('getGoldAnalysis should reject dates before 2013-01-02', async () => {
    await expect(
      analyzer.getGoldAnalysis('2010-01-01', '2015-01-01')
    ).rejects.toThrow(/2013-01-02/);
  });

  test('getGoldAnalysis should fetch and analyze gold prices', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { data: '2020-01-02', cena: 230.50 },
        { data: '2020-01-03', cena: 231.00 }
      ])
    });
    const result = await analyzer.getGoldAnalysis('2020-01-01', '2020-01-03');
    expect(result.rates.length).toBe(2);
    expect(result.sessions.up).toBe(1);
    expect(result.stats.count).toBe(2);
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

  const DOM = `
    <select id="analysisType">
      <option value="sessions">Sessions</option>
      <option value="stats" selected>Stats</option>
      <option value="distribution">Distribution</option>
      <option value="gold">Gold</option>
    </select>
    <select id="tableType"><option value="A">A</option></select>
    <div id="currencyWrap">
      <select id="currency">
        <option value="EUR">EUR — Euro</option>
        <option value="USD">USD — US Dollar</option>
        <option value="GBP">GBP — British Pound</option>
      </select>
    </div>
    <div id="currencyBWrap">
      <select id="currencyB">
        <option value="EUR">EUR — Euro</option>
        <option value="USD">USD — US Dollar</option>
        <option value="GBP">GBP — British Pound</option>
      </select>
    </div>
    <select id="period"><option value="30">30</option></select>
    <input type="date" id="startDate">
    <select id="distGran"><option value="monthly">Monthly</option></select>
    <button id="runBtn">Run</button><button id="exportBtn" disabled>Export</button>
    <div id="status"></div>
    <div id="results" hidden>
      <div id="resultsTitle"></div><p id="meta"></p>
      <div id="currentRateBar" hidden></div>
      <div id="dashboard"></div>
      <div id="legend" hidden></div>
      <div class="tab" data-view="chart"></div><div class="tab" data-view="table"></div>
      <div id="chartWrap">
        <canvas id="chart"></canvas><div id="chartTooltip" hidden></div>
      </div>
      <div id="tableWrap" hidden></div>
    </div>
    <div id="nbpTableWrap"></div><div id="startDateWrap"></div><div id="distGranWrap"></div>
  `;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      clearRect: jest.fn(), beginPath: jest.fn(), closePath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(),
      stroke: jest.fn(), fillText: jest.fn(), fillRect: jest.fn(), setLineDash: jest.fn(),
      save: jest.fn(), restore: jest.fn(), translate: jest.fn(), rotate: jest.fn(),
      arc: jest.fn(), fill: jest.fn(),
    }));

    document.body.innerHTML = DOM;
    global.fetch = jest.fn();
    ui = new UIController();
  });

  test('Flow: statistical analysis renders cards, rate bar and enables export', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: [
          { effectiveDate: '2023-01-01', mid: 4.0 },
          { effectiveDate: '2023-01-02', mid: 4.2 }
        ]
      })
    });

    ui.els.analysisType.value = 'stats';
    await ui.run();

    expect(ui.els.results.hidden).toBe(false);
    expect(ui.els.status.textContent).toBe('Done.');
    expect(document.querySelectorAll('.stat-card').length).toBeGreaterThan(0);
    expect(ui.els.currentRateBar.hidden).toBe(false);
    expect(ui.els.exportBtn.disabled).toBe(false);
  });

  test('Flow: session analysis renders 3 cards with percentages (S2-07)', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: [
          { effectiveDate: '2023-01-01', mid: 4.0 },
          { effectiveDate: '2023-01-02', mid: 4.1 },
          { effectiveDate: '2023-01-03', mid: 4.0 }
        ]
      })
    });

    ui.els.analysisType.value = 'sessions';
    ui.els.currency.value = 'USD';
    await ui.run();

    expect(ui.els.status.textContent).toBe('Done.');
    expect(document.querySelectorAll('.session-card').length).toBe(3);
    expect(ui.els.currentRateBar.hidden).toBe(false);
    expect(ui.els.exportBtn.disabled).toBe(false);
  });

  test('Flow: distribution analysis renders a table and enables export', async () => {
    global.fetch = jest.fn((url) => {
      const isEUR = url.includes('/eur/');
      const rates = isEUR
        ? [{ effectiveDate: '2023-01-02', mid: 1.0 }, { effectiveDate: '2023-02-02', mid: 1.0 }]
        : [{ effectiveDate: '2023-01-02', mid: 4.0 }, { effectiveDate: '2023-02-02', mid: 4.4 }];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ rates }) });
    });

    ui.els.analysisType.value = 'distribution';
    ui.els.currency.value = 'USD';
    ui.els.currencyB.value = 'EUR';
    ui.els.startDate.value = '2023-01-01';
    await ui.run();

    expect(ui.els.status.textContent).toBe('Done.');
    expect(ui.els.tableWrap.querySelector('table')).not.toBeNull();
    expect(ui.els.exportBtn.disabled).toBe(false);
  });

  test('Flow: invalid currency input is rejected with an error message (S2-05)', async () => {
    ui.els.analysisType.value = 'stats';
    ui.els.currency.value = 'not-a-currency';
    await ui.run();

    expect(ui.els.status.classList.contains('error')).toBe(true);
    expect(ui.els.status.textContent).toMatch(/not a valid currency/i);
    expect(ui.els.exportBtn.disabled).toBe(true);
  });

  test('Flow: User toggles between Chart and Table views', () => {
    const tableTab = document.querySelector('.tab[data-view="table"]');

    expect(ui.els.chartWrap.hidden).toBe(false);
    expect(ui.els.tableWrap.hidden).toBe(true);

    ui.switchView(tableTab);

    expect(ui.els.chartWrap.hidden).toBe(true);
    expect(ui.els.tableWrap.hidden).toBe(false);
  });
});
