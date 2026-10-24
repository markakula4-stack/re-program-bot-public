# Security

Report suspected vulnerabilities privately to the repository owner. Do not post credentials,
personal data, live payment details or exploit traffic in public issues. If private vulnerability
reporting is enabled on GitHub, use the repository Security tab.

The public CI pipeline performs local synthetic tests and source builds only. It has no production
secrets, deployment permissions, backup credentials or privileged pull-request execution.

Security-sensitive changes need owner review and negative regression tests. Audit conclusions
describe the checked source, not a guarantee about a live deployment or all possible attacks.
