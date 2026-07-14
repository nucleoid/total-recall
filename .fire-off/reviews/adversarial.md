# Adversarial review status

The required opposite-family review could not run.

- Claude Code subscription attempt (`claude-opus-4-8`) returned: `You've hit your org's monthly spend limit`.
- Two supervised reviewer allocations also settled as `blocked` without review output.
- No same-family or metered-provider fallback was used.

Operator action: restore the configured Anthropic review capacity and rerun adversarial review on PR #127 before merge.
