# NBP Currency Analyzer

A professional analytical tool for financial data, utilizing the National Bank of Poland (NBP) API to provide statistical insights into currency and gold markets.

## System Architecture

The application is built using a **Service-Oriented Architecture** with a clear separation of concerns:

1.  **UI Layer (`UIController`)**: 
    - Manages the DOM, handles user input, and triggers rendering logic.
    - Uses a **state-cleaner** pattern to reset visualizations between analysis runs.
2.  **Service Layer (Facade Pattern - `CurrencyAnalyzer`)**: 
    - Acts as a single entry point for the frontend.
    - Orchestrates the data flow between the API service and the analytical engine.
3.  **Data Access Layer (`NBPService`)**: 
    - Handles asynchronous communication with the NBP REST API.
    - Implements **Request Chunking**: Automatically splits long-term requests (e.g., 5 years) into valid 360-day segments to bypass API limitations.
4.  **Mathematical Engine (`AnalysisService`)**: 
    - Pure logic layer performing statistical calculations (Median, StdDev, etc.) and trend detection.
    - Ensures **Floating Point Precision** by rounding all outputs to 4 decimal places.

## Execution & Environment

### **Prerequisites**
- A modern web browser (Chrome, Firefox, Edge).
- [Node.js](https://nodejs.org/) (Version 20 and above) for running automated tests.

### **Running the Application**
1.  **Frontend**: Open `index.html` directly in your browser. No server is required as the app communicates directly with the NBP API via CORS.
2.  **Development/Testing**:
    - Install dependencies: `npm install`
    - Run tests: `npm test`

## Continuous Integration (CI)

The project utilizes **GitHub Actions** to maintain code quality and prevent regressions.

- **Trigger**: The pipeline runs automatically on every `push` or `pull_request` to the `main`, `release`, or `develop` branches.
- **Environment**: Runs on `ubuntu-latest` with **Node.js 20**.
- **Process**:
    1.  Checkouts the source code.
    2.  Installs NPM dependencies.
    3.  Executes the test suite using **Jest**.
- **Headless Testing**: E2E simulations are performed in a **JSDOM environment**, allowing the CI to validate UI logic and API integration without a graphical display.

## Data Visualization
- **Line Charts**: Used for historical rate trends.
- **Histograms**: Used for change distribution across 10 frequency bins.
- **Dashboard**: Real-time summary chips and statistical cards.

## Export Functionality
Users can export any generated analysis to **CSV** format. The exported file includes timestamped data and follows standard quote-escaping rules for maximum compatibility with Excel/Google Sheets.
## Deployment

The `release-and-deploy.yml` workflow runs on pushes to the `release` branch and:

1. Auto-generates a semantic version tag and a GitHub Release.
2. Publishes the static site to **GitHub Pages** (`upload-pages-artifact` → `deploy-pages`).

Because the app is fully static and talks to the NBP API directly over CORS, the
Pages URL is the production deployment — no server component is required.

> Release tag note: the tagger uses `default_bump: minor`. To emit `v2.0.0`
> specifically, set `custom_tag: 2.0.0` on the tag step or align it with the
> `package.json` version.

## Project Backlog & Documentation

- **Product backlog / user stories:** GitHub Projects — _add board link here_
- **UML (activity, sequence, component):** [`docs/UML.md`](docs/UML.md)
- **Acceptance test report (SRS deviations, Must/Should/Could):** [`docs/ACCEPTANCE_TEST_REPORT.md`](docs/ACCEPTANCE_TEST_REPORT.md)

## Test Reports

`npm test` runs the Jest suite (29 tests) covering the API layer, statistical and
session logic, cross-rate/distribution binning, CSV export, and end-to-end UI flows
(UC-001…UC-004) in a jsdom environment. The same command runs in CI on every push
and pull request to `main`, `release`, and `develop`.
