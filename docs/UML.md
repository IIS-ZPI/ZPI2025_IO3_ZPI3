# Project UML Documentation

## 1. Activity Diagram (Analysis Workflow)
This diagram describes the logic flow of the `run()` function in the `UIController`.

```mermaid
flowchart TD
    A([Start]) --> B[User selects parameters]
    B --> C[User clicks 'Run Analysis']
    C --> D[Clear previous results & show loading]
    D --> E{Analysis Type?}
    E -- Gold --> F[Fetch Gold Prices]
    E -- Currency --> G[Fetch Currency Rates]
    F --> H{API Success?}
    G --> H
    H -- No --> I[Show error message & hide results]
    H -- Yes --> J[Process stats & sessions]
    J --> K[Render Dashboard Cards & Charts]
    K --> L[Populate Data Table]
    L --> M[Enable CSV Export]
    M --> N([End])
    I --> N
```

## 2. Sequence Diagram (Component Interaction)
This diagram illustrates how different classes communicate during a standard currency analysis.

```mermaid
sequenceDiagram
    participant U as User
    participant UI as UIController
    participant CA as CurrencyAnalyzer
    participant NS as NBPService
    participant API as NBP API

    U->>UI: Click "Run analysis"
    UI->>CA: getStatistics(table, code, range)
    CA->>NS: fetchRates(table, code, start, end)
    NS->>API: HTTP GET /exchangerates/rates/...
    API-->>NS: JSON Data
    NS-->>CA: Normalized Rates Array
    CA->>CA: analyzeStats(rates)
    CA-->>UI: Analysis Results Object
    UI->>UI: drawLineChart()
    UI->>UI: renderStats()
    UI-->>U: Display charts and stats
```