# Agent Multimodal Input Specification

## Purpose

Define the multimodal contract of `POST /v1/agent`: accepted screenshot inputs are attached to
the first Meta turn only, after which the Meta conversation thread retains them as context for
the rest of the mission.

## Requirements

### Requirement: Images attached on the first turn only

Accepted images SHALL be attached to the model request on the first step of the loop. From the
second step onward the loop MUST send no images, because the Meta thread already carries the
attachments as context.

#### Scenario: Images ride the first step

- GIVEN an agent job with accepted images
- WHEN the loop performs its first model turn
- THEN those images MUST be attached to that turn

#### Scenario: Later steps send no images

- GIVEN an agent job with accepted images that has completed its first step
- WHEN a later model turn is performed
- THEN no images MUST be attached to that turn

### Requirement: Attachments remain thread context

The first-turn attachments SHALL remain part of the Meta conversation thread, so the model can
still see the screenshots while interpreting later command output without re-sending them.

#### Scenario: The mission continues with the screenshots visible

- GIVEN the first turn attached a screenshot
- WHEN the loop sends the next turn's command feedback
- THEN the screenshot MUST still be visible to the model as prior thread context

### Requirement: Images survive job persistence and recovery

Accepted images SHALL be stored with the job and mirrored to durable storage, and a recovered
agent job SHALL replay them on its first turn.

#### Scenario: A recovered job replays its images on the first turn

- GIVEN a persisted agent job with accepted images
- WHEN the broker recovers and pumps that job
- THEN its first model turn MUST attach those images again
