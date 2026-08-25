# Project Rules

## Full End-to-End Production Verification Rule
Before declaring ANY task, web app, or feature "Production Ready":
1. **Never Rely on Static Syntax Checks Alone**: Running syntax checks or linting is necessary but INSUFFICIENT.
2. **Audit End-to-End User Flows**:
   - Verify OAuth Client IDs and domain authorization (e.g., cross-origin Google/Firebase Auth settings).
   - Ensure demo fallback passcodes are NEVER printed onto UI notice banners or toast notifications in production mode.
   - Verify live form submissions, network API responses, and database/storage persistence.
3. **No False Production Claims**: Never claim "Production Ready" without empirical runtime evidence of end-to-end user workflows.
