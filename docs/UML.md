# Project UML Documentation

## 1. Activity Diagram (Analysis Workflow)
This diagram describes the logic flow of the `run()` function in the `UIController`.

```mermaid
flowchart TD
    A([Start]) --> B[User selects parameters]
    B --> C[User clicks 'Run Analysis']
    C --> D[Clear previous results & Show Skeleton Loader]
    D --> E[Disable 'Run' Button, Set status 'Fetching...']
    
    E --> F{Try: Analysis Type?}
    
    subgraph TryBlock [Execution Path]
        F -- Sessions --> G1[CA: getSessionAnalysis]
        F -- Stats --> G2[CA: getStatistics]
        F -- Gold --> G3[CA: getGoldAnalysis]
        F -- Distribution --> G4[CA: getDistribution]
        
        G1 --> J{API Fetch & Validation}
        G2 --> J
        G3 --> J
        G4 --> J
        
        J -- OK --> K[Execute Analysis via AnalysisService]
        K --> L1[UI: clearSkeleton]
        L1 --> L2[UI: setMeta & renderCurrentRateBar]
        L2 --> L3[UI: Render Charts, Dashboards & Tables]
        L3 --> M[UI: Prepare Data for CSV Export]
        M --> N[Set status: 'Done.']
    end
    
    subgraph CatchBlock [Error Handling Path]
        J -- "HTTP 404 (No data) / HTTP 5xx (Server Error)" --> O[Throw NBPServiceError]
        J -- "Validation Error (Invalid code, Date < Min)" --> O
        O --> P1[UI: clearSkeleton]
        P1 --> P[Catch: Show error message in UI status bar]
    end
    
    N --> Q
    P --> Q
    
    subgraph FinallyBlock [Cleanup]
        Q[Enable 'Run' Button]
    end
    
    Q --> R([End])
```

## 2. Sequence Diagram (Component Interaction)
This diagram illustrates how different classes communicate during a standard currency analysis.

```mermaid
sequenceDiagram
    participant U as User
    participant UI as UIController
    participant CA as CurrencyAnalyzer
    participant AS as AnalysisService
    participant NS as NBPService
    participant API as NBP API

    U->>UI: Click "Run analysis"
    UI->>UI: clearResults() & showSkeleton()
    UI->>CA: getStatistics(table, code, range)
    CA->>NS: fetchRates(table, code, start, end)
    NS->>API: HTTP GET /exchangerates/rates/...
    API-->>NS: JSON Data (or throw 404/500 error)
    NS-->>CA: Normalized Rates Array
    CA->>AS: analyzeStats(rates)
    AS-->>CA: Stats Object (mean, median, etc.)
    CA-->>UI: { rates, stats } object
    UI->>UI: clearSkeleton() & setMeta()
    UI->>UI: renderCurrentRateBar()
    UI->>UI: drawLineChart() & renderStats()
    UI-->>U: Display updated dashboard
```

## 3. Component Diagram (System Architecture)
This diagram illustrates the structural architecture of the application.

```mermaid
flowchart TB
    subgraph PresentationLayer [Presentation Layer]
        UI["UIController <br/><i>(Skeleton UI, Charts, Fallback lists)</i>"]
        CSV["CSVExporter"]
    end

    subgraph ApplicationLayer [Application Layer]
        CA["CurrencyAnalyzer <br/>«Facade» <br/><i>(Gold, Stats, Sessions, Dist)</i>"]
    end

    subgraph BusinessAndDataLayer [Business & Data Services]
        AS["AnalysisService <br/><i>(Stats, Arrays, Histogram Bins)</i>"]
        NS["NBPService <br/><i>(Rates, Gold, API Currency Lists)</i>"]
        ERR["NBPServiceError <br/>«Exception»"]
    end

    subgraph ExternalSystems [External Systems]
        API(("NBP API"))
    end

    %% Relationships and Dependencies
    UI -->|orchestrates via| CA
    UI -->|uses for download| CSV
    CA -->|delegates calculations to| AS
    CA -->|fetches data via| NS
    NS -->|HTTP GET/JSON| API
    NS -.->|throws 404 / 5xx| ERR
    CA -.->|throws validation errors| ERR
```