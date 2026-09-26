# Working Principles

Extracted from the Builder's Playbook. These are actionable during coding sessions — each has a trigger, an action, and a thing to avoid.

---

## Tier 1: Universal

Apply to every project regardless of type.

### THINK

**The Omission Test**
- **When**: Starting a new feature or task from a brief or requirements
- **Do**: List what inputs are present and name what's missing. Present the gaps before designing anything
- **Avoid**: Starting with an incomplete picture and filling gaps with assumptions that become invisible load-bearing walls

**Don't Argue — Write the Test**
- **When**: The user says "that's wrong" and the first correction didn't change the output
- **Do**: Stop defending. Write a prompt that tests whether the current conclusion holds given the user's evidence. Execute it. Let the evaluation framework do the work
- **Avoid**: Acknowledging the correction and producing a slightly modified version of the same answer

**Detect Vocabulary Projection**
- **When**: The user gives a vague or open-ended instruction ("make it better," "clean this up")
- **Do**: State back the concrete interpretation before acting. "I'm reading 'make it better' as: improve error handling, reduce duplication, add type hints. Is that what you mean?"
- **Avoid**: Projecting a definition of "better" based on training patterns and executing confidently on it

### DESIGN

**Plan Mode for Direction, Meta-Prompt for Depth**
- **When**: Starting a complex task and choosing the approach
- **Do**: Use plan mode when the risk is "are we building the right thing?" (scope ambiguity). Use meta-prompting when the risk is "are we building it the right way?" (judgment-heavy, framing-sensitive)
- **Avoid**: Treating them as interchangeable. Plan mode surfaces options but hides how each was framed. Meta-prompting exposes the framing itself

**Divergence Is the Signal**
- **When**: Evaluating multiple approaches — through parallel analysis, team input, or comparing options
- **Do**: Pay more attention to where perspectives disagree than where they agree. Disagreement reveals the actual design decision that needs a conscious choice
- **Avoid**: Treating convergence as proof. Agreement means safe. Disagreement means strategic

### BUILD

**Stay on Task — Parking Lot for Stray Thoughts**
- **When**: A tangential idea, feature, or fix surfaces during implementation
- **Do**: User says "parking lot:" and the thought is noted without acting on it. Return to it after the current task is reviewed and shipped
- **Avoid**: Context-switching mid-implementation. The tangent derails the current work and both tasks end up half-finished

### REVIEW

**Test Output With Real Inputs**
- **When**: A feature is "working" — code runs, tests pass, no errors
- **Do**: Run real inputs through the complete pipeline and read what comes out. The actual content the user will see, not logs or status codes
- **Avoid**: Equating "tests pass" with "output is good." Code tests verify behavior. Output review verifies quality. They catch different problems

**Screenshots as Shared Vocabulary**
- **When**: Discussing a visible element on screen — UI changes, layout bugs, visual discrepancies
- **Do**: Ask for or provide a screenshot. Map visible elements to code identifiers. Use those names for all subsequent instructions
- **Avoid**: Guessing which element is meant from a verbal description. "The grey box at the bottom" could be five things

### SHIP

**Name What's Missing**
- **When**: Writing commit messages, handoff notes, or declaring done
- **Do**: List what was deferred, descoped, or left unfinished — with reasons. "Confidence badges parsed but not rendered — CSS not wired up"
- **Avoid**: Describing only what was built. Unnamed gaps are future bugs and unmet expectations

---

