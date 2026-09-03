## Summary

Describe the user-visible or repository-level outcome.

## Change type

- [ ] Product source under `site/`
- [ ] Deck Library or example content
- [ ] Tests or build tooling
- [ ] Documentation or repository governance

## Verification

List the commands you ran and their results. The default gate is:

```bash
npm --prefix site ci
npm --prefix site run lint
npm run verify
```

## Release and data boundaries

- [ ] I did not include credentials, learner data, private source material, or provider output.
- [ ] I recorded provenance and redistribution rights for new content or assets.
- [ ] State-changing behavior has focused tests.
- [ ] If `site/` changed, this PR identifies the Website source commit and the deployment/parity plan.
- [ ] I did not describe structural checks as human review or measured learning outcomes.
