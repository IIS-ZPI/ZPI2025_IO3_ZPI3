const { NBPService, NBPServiceError } = require('./app.js');

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

const { AnalysisService } = require('./app.js');

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