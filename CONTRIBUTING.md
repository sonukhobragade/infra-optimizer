# Contributing

Thanks for taking a look. This is a small project, so the process is short.

## Getting set up

```bash
npm ci
npm start          # dev server
```

Sample CSVs are in `sample-data/`, so you can exercise the whole flow without
touching a real cluster export.

## Before you open a pull request

Run the gate:

```bash
bash tools/local_gate.sh
```

That is lint, tests, and a production build. CI runs the same script, so a green
gate locally means a green gate on GitHub. Note the build runs with `CI=true`,
which turns warnings into errors: an unused import fails the gate.

If the gate is red, fix the code. Do not weaken a check to make it pass.

## Where the logic lives

`src/utils/recommendations.js` is pure: usage figures in, recommended limits out.
It is deliberately separate from the React component so it can be tested without
rendering the UI and uploading two CSVs. Put sizing logic there, not in the
component.

## Changing a threshold

The constants in `JAVA_RULES` encode a judgement about how much headroom a JVM
needs. Changing one changes every recommendation the tool produces, and these
numbers get applied to production deployments.

So a threshold change needs:

- The reasoning in the PR description, not only the diff.
- Boundary tests. `recommendations.test.js` pins the value on both sides of
  every band edge, because an off-by-one at a threshold silently re-sizes every
  service sitting exactly on it.

## What not to send

No real cluster exports, internal service names, hostnames, namespaces, cost
figures, or account identifiers, in code, fixtures, issues, or screenshots. If
you need a fixture, write a synthetic one; `sample-data/` shows the columns.

## Reporting bugs

Open an issue with the CSV columns you used (not the data), what the tool
recommended, and what you expected.
