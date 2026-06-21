const {median, mode, stddev, analyzeSessions} = require('./app.js');

describe('Test algorithmic functions', () => {
    test('median calculations for even and odd element count', () => {
        expect(median([1, 5, 3])).toBe(3);
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    test('stddev calculations for average and standard deviation', () => {
        const result = stddev([10, 10, 10]);
        expect(result.mean).toBe(10);
        expect(result.std).toBe(0);//every number is the same so std should be 0
    });

    test('mode finds a number that occurred the most times in array', () => {
        const result = mode([1, 5, 2, 5, 3, 5]);
        expect(result.value).toBe(5);
        expect(result.count).toBe(3);
    });
});

describe('Test for session analysis', () => {
    test('analyzeSessions - test on mockup data, should correctly get info about trends', () => {
        const rates = [
            {date: '2023-01-01', value: 4.50},
            {date: '2023-01-02', value: 4.60},
            {date: '2023-01-03', value: 4.40},
            {date: '2023-01-04', value: 4.40}
        ];
        const result = analyzeSessions(rates);

        //check if currency changes are correct
        expect(result.up).toBe(1);
        expect(result.down).toBe(1);
        expect(result.flat).toBe(1);

        //check if func generated 3 rows with correct trend data
        expect(result.rows.length).toBe(3);
        expect(result.rows[0].cls).toBe('up');
        expect(result.rows[1].cls).toBe('down');
        expect(result.rows[2].cls).toBe('flat');
    });
});