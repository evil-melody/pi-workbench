/**
 * Team dispatch instruction: turn "delegate this turn" into a tool call the model can execute.
 *
 * The old frontend prefixed the prompt with `/team dispatch <id> <task>`. Pi routes
 * registered commands through the command channel, which emits no message_start /
 * message_end / agent_settled. The frontend kept streaming until the 180s idle
 * watchdog, showing "waiting for model response" with zero steps while the team
 * was in fact running in the background (2026-11-22 screenshot evidence).
 *
 * Going through the team_dispatch tool instead: the tool returns a run id at once,
 * the model then writes a short closing reply, agent_settled arrives normally and
 * the step strip shows the call. Member progress lives in the agent lanes panel.
 */
export function teamDispatchInstruction(teamId: string, task: string): string {
  const id = teamId.trim()
  if (!id) return task
  return [
    `You are the team lead. First call the team_dispatch tool: team_id="${id}", task = the user text below.`,
    'The tool returns a run id immediately and members run in the background. Do not call a non-existent Agent tool, do not wait for member output, and do not write member results yourself.',
    'Call it exactly once. Even if it reports an error or a duplicate, do not retry and do not run bash to do the members\' work yourself — report the message and stop.',
    'After the call, tell the user the run id in one sentence and point them to the agent lanes panel for progress.',
    '',
    '--- USER TASK ---',
    task,
  ].join('\n')
}
