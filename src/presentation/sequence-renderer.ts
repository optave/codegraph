interface Participant {
  id: string;
  label: string;
}

interface SequenceMessage {
  from: string;
  to: string;
  type: string;
  label: string;
}

interface SequenceRenderData {
  participants: Participant[];
  messages: SequenceMessage[];
  truncated: boolean;
  depth: number;
}

function escapeMermaid(str: string): string {
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/:/g, '#colon;')
    .replace(/"/g, '#quot;');
}

export function sequenceToMermaid(seqResult: SequenceRenderData): string {
  const lines = ['sequenceDiagram'];

  for (const p of seqResult.participants) {
    lines.push(`    participant ${p.id} as ${escapeMermaid(p.label)}`);
  }

  for (const msg of seqResult.messages) {
    const arrow = msg.type === 'return' ? '-->>' : '->>';
    lines.push(`    ${msg.from}${arrow}${msg.to}: ${escapeMermaid(msg.label)}`);
  }

  if (seqResult.truncated && seqResult.participants.length > 0) {
    const firstParticipant = seqResult.participants[0]!;
    lines.push(`    note right of ${firstParticipant.id}: Truncated at depth ${seqResult.depth}`);
  }

  return lines.join('\n');
}
