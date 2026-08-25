export type Author = "self" | "other";

export interface Reaction {
  readonly emoji: string;
  readonly actor: Author;
}

export interface Message {
  readonly author: Author;
  readonly timestamp: number;
  readonly reactions: readonly Reaction[];
}

export interface Conversation {
  readonly id: string;
  readonly person: string;
  readonly messages: Iterable<Message>;
}

export interface Datum {
  readonly label: string;
  readonly value: number;
}

export interface ReactionDatum {
  readonly emoji: string;
  readonly self: number;
  readonly other: number;
}

export interface MessageReport {
  readonly byAuthor: Readonly<Record<Author, number>>;
  readonly byHour: readonly Datum[];
  readonly byWeekday: readonly Datum[];
  readonly daily: readonly Datum[];
}

export interface ConversationSummary {
  readonly id: string;
  readonly person: string;
  readonly messageCount: () => number;
  readonly report: MessageReport;
  readonly reactions: readonly ReactionDatum[];
}

export interface MessageAnalysis {
  readonly conversations: readonly ConversationSummary[];
  readonly overview: MessageReport;
  readonly conversationTotals: readonly Datum[];
  readonly reactions: readonly ReactionDatum[];
}

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function padded(value: number): string {
  return String(value).padStart(2, "0");
}

function dayOf(date: Date): string {
  return [
    date.getFullYear(),
    padded(date.getMonth() + 1),
    padded(date.getDate()),
  ].join("-");
}

function monthly(daily: readonly Datum[]): readonly Datum[] {
  const totals = new Map<string, number>();
  for (const { label, value } of daily) {
    const month = label.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + value);
  }
  return series(totals);
}

function cumulative(daily: readonly Datum[]): readonly Datum[] {
  let running = 0;
  return daily.map(({ label, value }) => {
    running += value;
    return { label, value: running };
  });
}

export const trends = {
  Daily: (report: MessageReport) => report.daily,
  Monthly: (report: MessageReport) => monthly(report.daily),
  Cumulative: (report: MessageReport) => cumulative(report.daily),
} satisfies Record<string, (report: MessageReport) => readonly Datum[]>;

export type Trend = keyof typeof trends;

interface Aggregate {
  readonly byAuthor: Record<Author, number>;
  readonly byHour: number[];
  readonly byWeekday: number[];
  readonly daily: Map<string, number>;
  readonly reactions: Map<string, Record<Author, number>>;
}

function emptyAggregate(): Aggregate {
  return {
    byAuthor: { self: 0, other: 0 },
    byHour: Array(24).fill(0),
    byWeekday: Array(7).fill(0),
    daily: new Map(),
    reactions: new Map(),
  };
}

function addMessage(aggregate: Aggregate, message: Message): void {
  const date = new Date(message.timestamp);
  const hour = date.getHours();
  const weekday = (date.getDay() + 6) % 7;
  aggregate.byAuthor[message.author] += 1;
  aggregate.byHour[hour] = aggregate.byHour[hour]! + 1;
  aggregate.byWeekday[weekday] = aggregate.byWeekday[weekday]! + 1;

  const day = dayOf(date);
  aggregate.daily.set(day, (aggregate.daily.get(day) ?? 0) + 1);

  for (const reaction of message.reactions) {
    const counts = aggregate.reactions.get(reaction.emoji) ?? {
      self: 0,
      other: 0,
    };
    counts[reaction.actor] += 1;
    aggregate.reactions.set(reaction.emoji, counts);
  }
}

function series(values: ReadonlyMap<string, number>): readonly Datum[] {
  return [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => ({ label, value }));
}

function report(aggregate: Aggregate): MessageReport {
  return {
    byAuthor: { ...aggregate.byAuthor },
    byHour: aggregate.byHour.map((value, hour) => ({
      label: padded(hour),
      value,
    })),
    byWeekday: aggregate.byWeekday.map((value, weekday) => ({
      label: weekdays[weekday]!,
      value,
    })),
    daily: series(aggregate.daily),
  };
}

function reactions(aggregate: Aggregate): readonly ReactionDatum[] {
  return [...aggregate.reactions]
    .map(([emoji, counts]) => ({ emoji, ...counts }))
    .sort((left, right) =>
      right.self + right.other - left.self - left.other ||
      left.emoji.localeCompare(right.emoji)
    )
    .slice(0, 25);
}

function conversationTotals(
  conversations: readonly ConversationSummary[],
): readonly Datum[] {
  return conversations
    .map((conversation) => ({
      label: conversation.person,
      value: conversation.messageCount(),
    }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 25);
}

export function analyzeConversations(
  inputs: Iterable<Conversation>,
): MessageAnalysis {
  const overview = emptyAggregate();
  const conversations: ConversationSummary[] = [];

  for (const input of inputs) {
    const aggregate = emptyAggregate();
    for (const message of input.messages) {
      addMessage(aggregate, message);
      addMessage(overview, message);
    }
    const conversationReport = report(aggregate);
    conversations.push({
      id: input.id,
      person: input.person,
      messageCount: () =>
        conversationReport.byAuthor.self + conversationReport.byAuthor.other,
      report: conversationReport,
      reactions: reactions(aggregate),
    });
  }

  return {
    conversations,
    overview: report(overview),
    conversationTotals: conversationTotals(conversations),
    reactions: reactions(overview),
  };
}
