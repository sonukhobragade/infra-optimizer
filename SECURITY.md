# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That opens a private thread with the
maintainer.

Include what you found, how to reproduce it, and what an attacker gets. Expect a
first reply within a week. This is a personal project maintained in spare time.

## Supported versions

The latest commit on the default branch. There are no maintained release
branches.

## Scope

In scope: anything that executes content from an uploaded CSV, anything that
sends the uploaded data off the machine, and dependency vulnerabilities that
reach the built bundle.

The tool runs entirely in the browser. It parses the CSVs you drop into it and
renders recommendations. There is no backend, no upload, and no telemetry, so
your cluster metrics do not leave the page. If you find that they do, that is a
vulnerability and worth reporting.

## Worth knowing before you use the output

Not security issues, but they decide how much to trust a recommendation:

- **The output is advice, not a plan to apply blindly.** These numbers get
  applied to production deployments. A wrong reduction throttles a live service.
- **A missing metrics export is not an idle service.** With no usage samples the
  tool returns your current sizing rather than recommending a cut. Check that
  your export actually covers the window you think it does.
- **The thresholds are judgement, not measurement.** `JAVA_RULES` encodes an
  opinion about JVM headroom. It is a starting point for your own tuning.

## Do not commit real exports

A cluster metrics export carries internal service names, namespaces, and
capacity figures. Keep it out of issues, screenshots, and fixtures. Use
`sample-data/` for anything you share.
