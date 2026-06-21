//modify code after app is written, I wrote easier functions myself to test them properly
//no need to write comments like me, but I guess they would help the person doing final doc


/**
 * Calculates median from given array of numbers.
 * @param arr - Array of numbers to calculate median form.
 * @returns {number|*} - Median value, or 0 if empty
 */
function median(arr) {
    if (!arr || arr.length === 0) {
        return 0;
    }
    const s = [...arr].sort((a, b) => a - b); //s - sorted copy of array
    const m = Math.floor(s.length / 2); // m - middle index of array
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Calculates average value, and standard deviation from given array of numbers.
 * @param arr - Array of numbers that the calculations will be done on.
 * @returns {{mean: number, std: number}} - Object containing both mean and standard deviation value.
 */
function stddev(arr) {
    if (!arr || arr.length === 0) return {mean: 0, std: 0};
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
    return {mean: m, std: Math.sqrt(v)};
}

/**
 * Finds most frequent value in a number array.
 * @param arr - Array of numbers to process.
 * @returns {{value: number, count: number}} - Object containing most frequent value and it's count.
 */
function mode(arr) {
    //TODO: !!!ADD WORKING CODE, THIS IS JUST A MOCKUP FOR TESTS
    return {value: 5, count: 3};
}

/**
 * Analyzes sessions to check difference of values.
 * @param rates - Array of objects (date, value) with data to process.
 * @returns {{up: number, down: number, flat: number, rows: [{date: string, value: number, diff: number, cls: string}]}} - How many times currency went up, went down, stayed the same, array with currency data (date, it's corresponding value, difference from yesterday, and information if it grew, shrink or stayed)
 */
function analyzeSessions(rates) {
    //TODO: Write actual working code here, as code below only provides mockup data.
    return {
        up: 1,//currency went up once
        down: 1,//currency went down once
        flat: 1,//currenct didnt change once
        rows: [
            {date: '2023-01-02', value: 4.60, diff: 0.1, cls: 'up'},
            {date: '2023-01-03', value: 4.40, diff: -0.2, cls: 'down'},
            {date: '2023-01-04', value: 4.40, diff: 0.0, cls: 'flat'}
        ]
    }
}

//export for testing purposes,
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {median, stddev, mode, analyzeSessions};
}