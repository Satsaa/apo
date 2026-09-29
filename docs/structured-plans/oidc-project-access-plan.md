# OIDC project access

- User request
  - “I dont see a project when I log in. Can we bootstrap that? At least on dev”
- Observed problem
  - The configured project and owner membership exist, but the dashboard's project request receives HTTP 401 after a successful OIDC exchange.
- Fix
  - Preserve the backend-verified apo user identity through the Auth.js session so project access uses the existing membership.
  - Keep refused SSO exchanges refused and preserve credential sign-in behavior.
  - Validate the identity boundary with regression tests and verify the dev deployment without creating duplicate projects.
