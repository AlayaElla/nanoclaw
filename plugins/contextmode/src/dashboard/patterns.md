# Insight Pattern Catalog — 34 Patterns from 27 Metrics

Each pattern maps: **Metric → Threshold → Severity → Insight**

LLM receives the 27 metrics as JSON and generates insights by detecting these patterns.
This catalog is the reference for what's possible — LLM uses it as guidance, not as hardcoded rules.

## Needs Attention (7 patterns)

| # | Source Metric(s) | Pattern | Threshold | Insight Template |
|---|---|---|---|---|
| 1 | #22 CLAUDE.md freshness + #11 error rate | Stale instructions + high errors | >30 days + error > avg×1.5 | "{project} instructions are {N} days old — error rate is {X}× your average" |
| 2 | #11 error rate | Error rate spiked | this_week > prev_week | "Error rate increased from {prev}% to {current}%" |
| 3 | #1 context savings | Low savings | <90% | "Context savings at {N}% — below optimal 96%+" |
| 4 | #16 compaction frequency | Too many compactions | >5/week | "Context compacted {N} times — sessions filling up too fast" |
| 5 | #25 session outcome | Session failed | errors at end + 0 commits | "Session ended with {N} unresolved errors and no commits" |
| 6 | #24 rework rate | Excessive rework | >3 edits same file | "{file} was edited {N} times — unclear requirements or missing tests" |
| 7 | #23 iteration cycles | Loops without test | >3 cycles + no test file | "{file} had {N} edit→run→fix cycles — no test file exists" |

## Patterns Detected (8 patterns)

| # | Source Metric(s) | Pattern | Threshold | Insight Template |
|---|---|---|---|---|
| 8 | #23 iteration cycles | Moderate loops | 2-3 cycles | "{file} had {N} edit→run→fix cycles" |
| 9 | #24 rework rate | Moderate rework | 2-3 edits | "{file} was edited {N} times this session" |
| 10 | #12 tool diversity | Diversity declining | week < prev_week | "Tool diversity dropped from {prev} to {current}" |
| 11 | #4 session mix | Too exploratory | exploratory > 50% | "{N}% of session was exploratory — no commits shipped" |
| 12 | #14 time-of-day + #11 error rate | Afternoon error spike | PM_error > AM_error×1.5 | "Afternoon error rate is {N}× higher than morning" |
| 13 | #24 rework (cross-session) | Persistent struggle | same file across 3+ sessions | "{file} has been reworked across {N} sessions" |
| 14 | #26 subagent usage | Sequential agents | >3 agents + 0 parallel | "All {N} agents ran sequentially — parallel would be 3× faster" |
| 15 | #21 permission denials | Increasing denials | this > prev session | "Permission denials increased — you keep trying blocked patterns" |

## Wins (11 patterns)

| # | Source Metric(s) | Pattern | Threshold | Insight Template |
|---|---|---|---|---|
| 16 | #11 error rate | Error rate dropped | current < prev | "Error rate dropped from {prev}% to {current}%" |
| 17 | #13 efficiency score | Score improved | current > prev | "Efficiency score jumped {prev} → {current}" |
| 18 | #14 time-of-day | Morning productivity | AM_commits > PM×1.5 | "You're {N}× more productive before noon" |
| 19 | #12 tool diversity | High diversity | >=6 tools | "Used {N} different tools — high diversity" |
| 20 | #1 context savings | Excellent savings | >97% | "Context savings at {N}% — optimal performance" |
| 21 | #18 commits/session | Above average | >2/session | "Averaging {N} commits per session" |
| 22 | #22 + #11 | Fresh instructions + drop | CLAUDE.md updated + error dropped | "CLAUDE.md update correlated with error rate drop" |
| 23 | #2 Think in Code | High savings | >95% | "Think in Code saved {N}% — {X}× less context" |
| 24 | #16 compaction | Zero compactions | 0 this session | "No compactions needed — context stayed healthy" |
| 25 | #25 session outcome | Productive session | commits > 0 + no trailing errors | "Productive session — {N} commits, clean exit" |
| 26 | #26 subagent | Parallel agents | parallel > sequential | "Parallel agents completed {N}× faster" |

## Good to Know (8 patterns)

| # | Source Metric(s) | Pattern | Threshold | Insight Template |
|---|---|---|---|---|
| 27 | #21 permission denials | Security working | denials > 0 | "{N} unsafe commands blocked and redirected" |
| 28 | #26 subagent usage | Agent breakdown | any usage | "{N} subagents across {T} types" |
| 29 | #27 skill usage | Skill distribution | any usage | "{N} skills invoked — most used: {skill}" |
| 30 | #15 project distribution | Multiple projects | >2 projects | "Worked across {N} projects — most active: {project}" |
| 31 | #17 session count | Weekly trend | count change | "{N} sessions this week — {direction} from last week" |
| 32 | #7 session continuity | Events preserved | >10 | "{N} events persist across context resets" |
| 33 | #3 tool savings | Per-tool breakdown | any savings | "{tool} saved the most: {in}KB → {out}KB" |
| 34 | #19 sandbox I/O | Read vs output | any usage | "Sandbox read {read}KB from disk, only {out}KB exited" |

## Metric → Pattern Mapping

| Metric | Patterns it triggers |
|---|---|
| #1 Context savings | 3, 20 |
| #2 Think in Code | 23 |
| #3 Tool savings | 33 |
| #4 Session mix | 11 |
| #7 Continuity | 32 |
| #11 Error rate | 2, 12, 16, 22 |
| #12 Tool diversity | 10, 19 |
| #13 Efficiency score | 17 |
| #14 Time-of-day | 12, 18 |
| #15 Project distribution | 30 |
| #16 Compaction | 4, 24 |
| #17 Session count | 31 |
| #18 Commits/session | 21 |
| #19 Sandbox I/O | 34 |
| #21 Permission denials | 15, 27 |
| #22 CLAUDE.md freshness | 1, 22 |
| #23 Iteration cycles | 7, 8 |
| #24 Rework rate | 6, 9, 13 |
| #25 Session outcome | 5, 25 |
| #26 Subagent usage | 14, 26, 28 |
| #27 Skill usage | 29 |

## How LLM Uses This

LLM receives:
1. Metrics JSON (27 data points from AnalyticsEngine)
2. This catalog as reference (what patterns to look for)
3. Prompt: "Analyze metrics, generate 3-7 insights, Persona → Metric → Evidence → Action → ROI"

LLM does NOT hardcode rules. It reads the data, recognizes patterns from this catalog,
cross-references metrics (e.g., stale CLAUDE.md + high error rate = correlated insight),
and generates natural language insight cards.

The catalog grows as we add more metrics or discover new patterns.
