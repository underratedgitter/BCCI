---
name: full-production-testing
description: Use when checking or verifying if an app, feature, or service is production ready, before declaring readiness to the user
---

# Full Production Testing & End-to-End Verification

## Overview
Static analysis and unit syntax checks prove code compiles; end-to-end flow verification proves the app works for real users. Never claim production readiness without verifying live user paths.

## Mandatory Production Verification Checklist
Before declaring any project or feature "Production Ready":

1. **Domain & OAuth Origin Audit**:
   - Check if OAuth Client IDs (Google, GitHub, Facebook) match the live deployment domain or use cross-domain popups (Firebase Auth).
2. **On-Screen Secret Suppression**:
   - Ensure demo/mock OTP passcodes are NEVER printed onto UI notice banners or toast notifications in production mode.
   - Verify real SMS / Email dispatch triggers directly to user devices.
3. **End-to-End User Flow Execution**:
   - Test sign-up / login authentication flows end-to-end.
   - Test main feature workflows (form submission, payment, data persistence).
4. **Empirical Evidence Requirement**:
   - Report concrete test results to the user before making any success assertion.
