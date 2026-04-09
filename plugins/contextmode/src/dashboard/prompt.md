# Dashboard Insight Generation Prompt

Read the metrics JSON from `{{METRICS_PATH}}`.

Analyze the data for patterns, anomalies, correlations, wins, and risks.
Generate 3-10 insight cards following **Persona -> Metric -> Evidence -> Action -> ROI**.

```json
[
  {
    "severity": "high | medium | positive | info | declining | improving | recurring | goal",
    "badge": "Action needed | Pattern | Win | Trend | Alert | Declining | Improving | Recurring | Goal",
    "source": "which metric(s) — e.g. 'CLAUDE.md freshness + error rate'",
    "when": "today | this session | this week | 7-day trend | 30-day trend",
    "metric": "One sentence. What the data shows. Include numbers.",
    "evidence": "Why this matters. Correlations, comparisons, trends. Use <strong> for key numbers.",
    "action": "Specific thing to do. Not generic advice. A concrete next step.",
    "roi": "Estimated time or quality impact. Be specific."
  }
]
```

---

## Severity / Group Types (8)

| Severity | Badge | Color | When to use |
|----------|-------|-------|-------------|
| `high` | Action needed | red | Metric exceeds danger threshold — immediate action required |
| `medium` | Pattern | orange | Notable pattern detected — worth investigating |
| `positive` | Win | green | Something improved or exceeds target — celebrate it |
| `info` | Trend | blue | Interesting data point — no action needed, good to know |
| `declining` | Declining | red | Metric trending downward over 3+ data points |
| `improving` | Improving | green | Metric trending upward over 3+ data points |
| `recurring` | Recurring | orange | Same pattern appeared in 3+ sessions — systemic issue |
| `goal` | Goal | teal | North star metric progress — track against target |

---

## Context Detection: Individual vs Team

**Individual data only** (local SessionDB, no cloud sync):
- Generate Developer persona insights (free tier, 34 patterns)
- Use individual metrics: session efficiency, error rate, tool diversity, commit rate, CLAUDE.md freshness, etc.
- North Star: `Personal AI Efficiency = (commits/sessions) x (1 - error_rate) x tool_diversity_score` — trending up

**Team data present** (cloud sync, multiple developers):
- Generate persona-appropriate insights for CTO, EM, DevEx, Security, QA, etc.
- Use team-aggregated metrics: license utilization, team rework rate, adoption curves, etc.
- Match insights to the persona whose North Star is most relevant

---

## Priority Rating — ★★★ > ★★ > ★

- **★★★ KILLER** — Sells the product alone. Always surface these first.
- **★★ STRONG** — Supports the sale, makes it sticky. Surface when data is clear.
- **★ NICE** — Adds depth. Only include if space remains after higher-priority insights.

---

## Full Pattern Catalog — 143 Patterns across 9 Personas

### CTO / VP Engineering (8 metrics, 2 BLOCKED)
North Star: `AI ROI = (AI-assisted commits x avg session efficiency) / monthly AI spend` — target >3.0x (BLOCKED: needs cost data)

- #35 ★★★ Idle licenses detected (utilization < 80%) -> cancel unused -> $27K/yr saved
- #36 ★ Full utilization (>95%) -> healthy adoption
- #37 ★★★ ROI below target (ROI < 3x) -> board metric alert -> BLOCKED (needs cost data)
- #38 ★★ Productive rate declining (rate < 60%) -> investigate workflow friction
- #39 ★★ Platform fragmentation (3+ tools, no standard) -> standardize tooling
- #40 ★ Single-platform risk (>90% one tool) -> evaluate alternatives
- #41 ★★ Session trend declining (week-over-week drop >15%) -> engagement problem
- #42 ★ Session trend growing (>20% growth) -> adoption momentum
- #43 ★★ High compaction rate (>3/session avg) -> context filling too fast
- #44 ★ Low compaction (0-1/session) -> good context efficiency
- #45 ★★ Error rate divergence between platforms -> investigate worst platform
- #46-#47 ★★ Cost per session outliers -> optimize expensive sessions (BLOCKED)
- #48 ★★ Platform consolidation opportunity -> single standard saves training cost
- #49-#50 ★★★ ROI trend -> board-ready metric (BLOCKED)
- #51-#52 ★★ Cost anomaly detection (BLOCKED)

### Engineering Manager (7 metrics)
North Star: `Team AI Effectiveness = (committed features / AI session hours) x (1 - rework rate)` — target >0.8

- #53 ★★ Session too long (>3hr avg) -> break into smaller tasks
- #54 ★ Session duration sweet spot (1-2hr) -> team is focused
- #55 ★★ High iteration cycles (>8 edit-test-edit per file) -> needs tests or clearer specs
- #56 ★ Low iteration count -> efficient development
- #57 ★★ Excessive team rework (>10 edits/file avg) -> specs are unclear
- #58 ★ Low rework -> clean implementation discipline
- #59 ★★★ Slow time-to-first-commit (>2hr) -> onboarding or blockers
- #60 ★★★ High debug ratio (bugfix >60%) -> tech debt sprint needed
- #61 ★ Low debug ratio (<30%) -> healthy codebase
- #62 ★★ High exploration ratio (>50%) -> too much research, not enough execution
- #63 ★ Balanced explore/execute ratio -> good rhythm
- #64 ★★ Session count declining per developer -> engagement problem
- #65 ★ Session count growing -> adoption accelerating
- #66 ★★ Developer performance gap (top 3x bottom quartile) -> peer mentoring needed
- #67 ★★★ Rework + debug correlation (high rework + high bugfix) -> quality crisis
- #68 ★★ Fast iterators, slow committers -> work happening but not shipping

### DevEx Lead (7 metrics)
North Star: `Time-to-Productive = days until new dev reaches 80% of org avg` — target <14 days

- #69 ★★★ High day-3 drop-off (>30% users quit after 3 days) -> fix onboarding -> $200K/yr
- #70 ★ Fast adoption (80% usage in 2 weeks) -> onboarding is working
- #71 ★★ Low sandbox routing (<60%) -> devs bypassing context protection
- #72 ★ High routing (>80%) -> sandbox adoption is strong
- #73 ★★ Low tool diversity (<4 tools/dev/week) -> missing opportunities
- #74 ★ High diversity (>8 tools) -> platform well-utilized
- #75 ★★ Slow onboarding velocity (new dev < 60% of org avg after 4 weeks) -> improve ramp
- #76 ★ Fast onboarding -> starter kit is effective
- #77 ★★ Repeated prompts detected (clusters without skills) -> automate with skills
- #78 ★ Prompt-to-skill conversion active -> good automation culture
- #79 ★★ Platform outcome disparity -> investigate worst-performing platform
- #80 ★ Subagent adoption growing -> parallel execution culture
- #81 ★★★ DevEx health declining (adoption + diversity + onboarding all declining) -> systemic issue
- #82 ★★ Prompt repetition + no skills -> manual work persisting
- #83 ★ Routing + diversity both strong -> excellent DevEx

### Security / CISO (5 metrics)
North Star: `AI Security Score = 1 - (unblocked dangerous actions / total dangerous attempts)` — target >0.99

- #85 ★★ Permission denial spike (>2x average) -> investigate offender
- #86 ★ Low denial rate -> healthy permission model
- #87 ★ Zero denials -> either perfect behavior or missing rules (check which)
- #88 ★★★ Unauthorized MCP server connection -> block immediately -> supply chain risk
- #89 ★ Clean MCP compliance -> policy is enforced
- #90 ★★★ Dangerous command attempted (rm -rf, DROP TABLE, etc.) -> immediate block
- #91 ★ Zero dangerous commands -> good developer discipline
- #92 ★★★ Secret exposed in output (API key, token, password) -> rotate immediately
- #93 ★ No secrets detected -> output scanning working
- #94 ★★ Sandbox escape attempt (file access outside project boundary) -> tighten policy
- #95 ★ Clean file access -> sandbox boundaries holding
- #96 ★★★ Security composite (3+ security metrics triggered) -> comprehensive audit needed

### FinOps (5 metrics, 4 BLOCKED)
North Star: `AI Cost Efficiency = committed features / total AI spend per month` — BLOCKED (needs cost data)

- #97-#98 ★★ Cost per team outlier -> investigate high-cost teams (BLOCKED)
- #99 ★★★ Expensive model overuse (>80% calls use most expensive model) -> route simple tasks cheaper (BLOCKED)
- #100 ★ Balanced model mix -> cost-efficient routing (BLOCKED)
- #101-#102 ★★ Budget utilization mismatch -> right-size budgets (BLOCKED)
- #103-#104 ★ Cache hit rate optimization -> reduce redundant calls (BLOCKED)
- #105-#106 ★★ Cost per commit outlier -> expensive low-value sessions (BLOCKED)

### QA Lead (5 metrics)
North Star: `AI Test Discipline = (sessions with tests / total sessions) x test first-pass rate` — target >0.60

- #109 ★★ Low test execution rate (<30% of sessions run tests) -> mandate test-first
- #110 ★ High test rate (>70%) -> testing culture strong
- #111 ★★ Low first-pass rate (<50% tests pass first time) -> better test generation
- #112 ★ High first-pass rate -> quality test output
- #113 ★★ High test iterations (>5 runs to pass) -> tests are flaky or poorly generated
- #114 ★ Low iteration count -> tests generated correctly
- #115 ★★ Nobody runs coverage (<5% of sessions) -> add to CI + create /coverage skill
- #116 ★ Coverage awareness growing -> discipline improving
- #117 ★★ Zero test file creation -> tests not being added to codebase
- #118 ★ Test files being created -> test-driven development active
- #119 ★★★ Quality crisis composite (test rate < 30% + first-pass < 40% + test files < 15%) -> mandatory quality sprint
- #120 ★★ QA metrics all healthy -> maintain current testing culture

### Developer / IC (5 metrics + 34 individual patterns)
North Star: `Personal AI Efficiency = (commits/sessions) x (1 - error_rate) x tool_diversity_score` — trending up

- #38 ★★ Personal productivity declining -> investigate workflow changes
- #39 ★★ Tool mastery plateau (no new tools in 4 weeks) -> explore new capabilities
- #40 ★★ Context underutilization (<80% context savings) -> improve routing
- #41 ★ Tool diversity growing -> expanding capability
- #42 ★★ Commit rate declining -> shipping less, investigate blockers

**Individual free-tier patterns (34 total):**

Needs Attention (7):
- #1 ★★ Stale CLAUDE.md + high errors (>30 days + error >1.5x avg) -> update instructions
- #2 ★★ Error rate spiked (this week >1.3x last week) -> review workflow changes
- #3 ★ Low context savings (<90%) -> route large outputs through sandbox
- #4 ★★ High compaction rate (>3/session) -> break tasks into smaller sessions
- #5 ★★ Session failed (errors at end + 0 commits) -> investigate root cause
- #6 ★ Iteration loop detected (>5 edit-run-fix on same file) -> write tests first
- #7 ★ Subagent underuse (0 spawned in complex tasks) -> parallelize work

Patterns Detected (9):
- #8 ★★ Tool diversity dropped (week-over-week decline) -> friction signal
- #9 ★ Same error recurring (3+ sessions) -> systemic config issue
- #10 ★★ Rework + no test file (3+ edits + 0 test files) -> compound quality gap
- #11 ★ Session length trending longer -> complexity creeping up
- #12 ★ Permission denials increasing -> stricter rules or more dangerous attempts
- #13 ★ Edit-heavy sessions with no commits -> work not shipping
- #14 ★ Exploration-heavy session (>70% prompts are questions) -> research mode, not building
- #15 ★★ Morning vs afternoon productivity gap -> scheduling insight

Wins (11):
- #16 ★★ Error rate dropped -> celebrate + document what changed
- #17 ★ Efficiency score improved -> workflow optimization working
- #18 ★ Morning productivity (AM commits >1.5x PM) -> protect focus blocks
- #19 ★ High tool diversity (>=6 tools) -> platform well-utilized
- #20 ★ Fast time-to-first-commit (<30min) -> hitting stride quickly
- #21 ★★ Context savings excellent (>96%) -> sandbox routing effective
- #22 ★ Zero errors in session -> clean execution
- #23 ★★ Commit streak (3+ sessions with commits) -> shipping consistently
- #24 ★ Low rework -> implementing cleanly
- #25 ★ Tests passing first try -> high-quality test generation
- #26 ★ Personal best session (highest efficiency ever) -> peak performance

Suggestions (7):
- #27 ★ Try subagents for parallel work -> could speed up 2-3x
- #28 ★ Add CLAUDE.md to project (none detected) -> improves consistency
- #29 ★ Explore new tools (only using 2-3) -> more capabilities available
- #30 ★ Create skills from repeated prompts -> automate manual patterns
- #31 ★ Add tests to high-rework files -> prevent iteration loops
- #32 ★ Review compaction triggers -> optimize context management
- #33 ★ Track weekly progress -> trends matter more than snapshots
- #34 ★ Goal: north star tracking -> personal efficiency trend line

### Onboarding (5 metrics)
North Star: `Ramp-Up Speed = days until new hire reaches 80% of org median session efficiency` — target <14 days

- #121 ★★★ Slow time-to-first-commit (new hire >3 days) -> improve starter config
- #122 ★ Fast first commit (<1 day) -> onboarding kit is effective
- #123 ★★ Slow tool discovery (new hire using <3 tools after 2 weeks) -> guided tour needed
- #124 ★ Fast tool discovery -> exploration culture working
- #125 ★★ No skills adopted after 4 weeks -> skill awareness training needed
- #126 ★ Rapid skill adoption -> good skill discoverability
- #127 ★★ Error rate not declining for new hire -> stuck, needs mentoring
- #128 ★ Error rate declining on schedule -> healthy learning curve
- #129 ★★ Session duration not normalizing -> may be struggling
- #130 ★ Session duration normalizing -> productive routines forming
- #131 ★★★ Onboarding at risk (3+ onboarding metrics below target) -> assign mentor + daily check-ins
- #132 ★ Onboarding excellence (all metrics above target) -> consider as future buddy

### Context / Knowledge Sharing (5 metrics)
North Star: healthy knowledge system prevents productivity loss from outdated or missing context

- #133 ★★ Stale CLAUDE.md (freshness < 50/100) -> review and update project instructions
- #134 ★ Fresh CLAUDE.md (>80/100) -> instructions are current
- #135 ★★ Repeated prompts (cluster count high) -> convert to skills or CLAUDE.md entries
- #136 ★★ Low skill effectiveness (skills created but not improving metrics) -> refine skill content
- #137 ★ High skill effectiveness -> skills delivering value
- #138 ★★ Low cross-team overlap (teams duplicating context) -> share best practices
- #139 ★ High healthy overlap -> knowledge flowing between teams
- #140 ★★★ Low context coverage (<70% sessions have CLAUDE.md) -> push managed configs org-wide
- #141 ★ High coverage (>90%) -> consistent agent behavior
- #142 ★★★ Knowledge rot detected (stale CLAUDE.md + repeated prompts + low coverage) -> knowledge hygiene initiative
- #143 ★ Knowledge system healthy (all context metrics above target) -> maintain processes

---

## Cross-Referencing Rules — Best Insights Connect 2+ Metrics

The most valuable insights combine multiple signals. When you detect a pattern, always check for correlated metrics:

| Signal A | Signal B | Compound Insight | Severity |
|----------|----------|------------------|----------|
| CLAUDE.md stale (>30d) | Error rate >1.5x avg | Outdated instructions causing failures | high |
| High iteration cycles (>8) | Rework rate >10 edits/file | No test file present = compound quality gap | high |
| Tool diversity dropping | Error rate rising | Friction signal — developer retreating to fewer tools | high |
| Morning productivity >1.5x PM | Session outcome: productive AM, failed PM | Schedule deep work in AM, review/meetings in PM | positive |
| Rework rate high | Debug ratio high | Quality crisis — poor code quality causing debug spiral | high |
| High compaction rate | Long session duration | Context filling too fast for task complexity | medium |
| Commit rate declining | Session count stable | Working but not shipping — investigate blockers | medium |
| Low sandbox routing | High context waste | Bypassing sandbox = flooding context window | high |
| Fast iteration count | Slow time-to-commit | Work happening but not landing — review/approval bottleneck | medium |
| Permission denials rising | New developer onboarded | Expected learning curve — provide guidance, not alarm | info |
| Subagent usage = 0 | Session duration >2hr | Parallel execution could cut session time | medium |
| Test rate < 30% | Rework rate > 10 | No tests + high rework = predictable failure loop | high |
| Error rate dropping | Tool diversity growing | Learning curve working — developer expanding capability safely | improving |
| All QA metrics below target | All EM rework metrics high | Systemic quality problem — mandatory quality sprint | high |

---

## BLOCKED Metrics — 7 Metrics That Cannot Be Measured

These metrics require `total_cost_usd`, `input_tokens`, `output_tokens`, or `model` data that platforms do NOT expose to hook stdin. **Never generate insights about these unless the data actually exists in the JSON:**

| # | Metric | Persona | Why Blocked |
|---|--------|---------|-------------|
| #7 | Cost per Session | CTO | Requires `SDKResult.total_cost_usd` |
| #8 | AI ROI (Board Metric) | CTO | Requires cost denominator |
| #28 | Cost per Team | FinOps | Requires per-session cost aggregation |
| #29 | Model Mix Distribution | FinOps | Requires `SDKResult.model` |
| #30 | Budget Utilization Rate | FinOps | Requires `SDKResult.total_cost_usd` |
| #31 | Cache Hit Rate | FinOps | Requires token-level data |
| #32 | Cost per Commit | FinOps | Requires cost + commit correlation |

If a cost/token field appears in the metrics JSON (meaning the platform added support), you MAY generate those insights. Otherwise, skip them entirely.

---

## Anti-Hallucination Rules

1. **Only reference metrics that exist in the JSON** — if a field is missing, skip all patterns that depend on it
2. **Never invent numbers** — use exact values from the data. If the value is `0.68`, say `68%`, not "approximately 70%"
3. **Never fabricate trends** — a trend requires 3+ data points. Two data points is a comparison, not a trend
4. **Never claim causation** — say "correlated with" not "caused by" unless the mechanism is obvious
5. **Skip BLOCKED metrics** (#7, #8, #28-#32) unless cost/token data is explicitly present
6. **Never round aggressively** — `$27,075` stays `$27,075`, not "about $27K"
7. **If fewer than 3 insights qualify, generate fewer** — never pad with weak insights
8. **Mark confidence** — if an insight depends on a single data point, say "based on limited data"

---

## Rules

- Sort by priority: ★★★ first, then ★★, then ★
- Within same priority, sort by severity: high > declining > recurring > medium > goal > improving > positive > info
- Only surface what is **surprising or actionable** — not everything
- Each insight must have **specific numbers** from the data
- Each action must be **concrete** — not "consider improving"
- Cross-reference metrics — the best insights connect 2+ data points
- Include at least 1 positive insight (wins matter for motivation)
- Badge text must be 1-2 words max
- For `declining` / `improving` severity: include the trend direction and magnitude
- For `recurring` severity: mention how many sessions the pattern appeared in
- For `goal` severity: show progress toward the North Star formula

---

## Output

Write the insight array into the template file at `{{TEMPLATE_PATH}}`.
Replace `{{INSIGHTS_JSON}}` with the JSON array.
Replace `{{METRICS}}` with the full metrics JSON object.
Then open the HTML file in the browser.
