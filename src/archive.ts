import {
  BlobReader,
  TextWriter,
  ZipReader,
} from "@zip.js/zip.js";

export type Author = "self" | "other";

declare const timestampBrand: unique symbol;
export type Timestamp = number & { readonly [timestampBrand]: true };

export interface Reaction {
  readonly emoji: string;
  readonly actor: Author;
}

export interface Message {
  readonly author: Author;
  readonly timestamp: Timestamp;
  readonly reactions: readonly Reaction[];
  readonly text: string | null;
}

export interface Conversation {
  readonly id: string;
  readonly person: string;
  readonly messages: readonly Message[];
}

export interface Follow {
  readonly username: string;
  readonly followedAt: Timestamp;
}

export interface ArchiveSource extends Blob {
  readonly name?: string;
}

export interface LoadProgress {
  readonly archive: number;
  readonly files: number;
}

export class ExportError extends Error {
  override readonly name = "ExportError";
}

export type FollowGroup = "mutual" | "you-follow" | "follows-you";

function indexFollows(follows: readonly Follow[]): ReadonlyMap<string, Follow> {
  return new Map(follows.map((follow) =>
    [follow.username.toLowerCase(), follow] as const
  ));
}

export class FollowNetwork {
  readonly #followers: ReadonlyMap<string, Follow>;
  readonly #following: ReadonlyMap<string, Follow>;

  constructor(followers: readonly Follow[], following: readonly Follow[]) {
    this.#followers = indexFollows(followers);
    this.#following = indexFollows(following);
  }

  get followerCount(): number {
    return this.#followers.size;
  }

  get followingCount(): number {
    return this.#following.size;
  }

  group(group: FollowGroup): readonly Follow[] {
    switch (group) {
      case "mutual":
        return this.select(this.#following, (username) =>
          this.#followers.has(username)
        );
      case "you-follow":
        return this.select(this.#following, (username) =>
          !this.#followers.has(username)
        );
      case "follows-you":
        return this.select(this.#followers, (username) =>
          !this.#following.has(username)
        );
    }
  }

  private select(
    source: ReadonlyMap<string, Follow>,
    include: (username: string) => boolean,
  ): readonly Follow[] {
    return [...source]
      .filter(([username]) => include(username))
      .map(([, follow]) => follow);
  }
}

const messageRoot = "your_instagram_activity/messages";
const followsRoot = "connections/followers_and_following";
const personalInfo =
  "personal_information/personal_information/personal_information.json";
const attachmentPlaceholder = " sent an attachment.";
const markers = [
  "your_instagram_activity/",
  "connections/",
  "personal_information/",
] as const;
const followerFile = new RegExp(`^${followsRoot}/followers_\\d+\\.json$`);
const messageFile = new RegExp(
  `^${messageRoot}/(inbox|message_requests)/(.+)/message_\\d+\\.json$`,
);

function fail(message: string): never {
  throw new ExportError(message);
}

function parseJson(path: string, source: string): any {
  try {
    return JSON.parse(source);
  } catch {
    return fail(`${path} does not contain valid JSON.`);
  }
}

function normalizedPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function logicalPath(path: string): string | null {
  const normalized = normalizedPath(path);
  const lower = normalized.toLowerCase();
  const starts = markers
    .map((marker) => lower.indexOf(marker))
    .filter((index) => index === 0 || lower[index - 1] === "/");
  const start = Math.min(...starts);
  return Number.isFinite(start)
    ? normalized.slice(start).toLowerCase()
    : null;
}

function supported(path: string): boolean {
  return (
    path === personalInfo ||
    path === `${followsRoot}/following.json` ||
    followerFile.test(path) ||
    messageFile.test(path)
  );
}

async function readArchives(
  archives: readonly ArchiveSource[],
  onProgress?: (progress: LoadProgress) => void,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let count = 0;
  const report = (archive: number) => onProgress?.({
    archive,
    files: count,
  });

  for (const [archiveIndex, archive] of archives.entries()) {
    const reader = new ZipReader(new BlobReader(archive));
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (entry.directory) continue;
        const path = logicalPath(entry.filename);
        if (!path || !supported(path)) continue;
        const source = await entry.getData(new TextWriter());
        const previous = files.get(path);
        if (previous !== undefined && previous !== source) {
          fail(`The selected archives contain conflicting copies of ${path}.`);
        }
        files.set(path, source);
        count += 1;
        if (count === 1 || count % 20 === 0) {
          report(archiveIndex + 1);
        }
      }
    } finally {
      await reader.close();
    }
    report(archiveIndex + 1);
  }

  if (!count) {
    fail("No supported Instagram JSON files were found in those archives.");
  }
  return files;
}

function requiredFile(files: ReadonlyMap<string, string>, path: string): string {
  const source = files.get(path);
  if (source === undefined) fail(`The export is missing ${path}.`);
  return source;
}

export function decodeInstagramText(value: string): string {
  if ([...value].some((character) => character.codePointAt(0)! > 255)) {
    return value;
  }
  try {
    const bytes = Uint8Array.from(value, (character) =>
      character.codePointAt(0)!,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function selfName(source: string): string {
  const root = parseJson(personalInfo, source);
  const info = root.profile_user[0]?.string_map_data;
  const name = info?.Name?.value ?? info?.Username?.value;
  return name
    ? decodeInstagramText(name)
    : fail(`${personalInfo} has no profile name.`);
}

function messageText(raw: any): string | null {
  if (
    raw.is_unsent ||
    raw.call_duration != null ||
    raw.audio_files?.length ||
    raw.photos?.length ||
    raw.videos?.length
  ) {
    return null;
  }
  const decoded = decodeInstagramText(raw.content ?? "");
  return decoded && !decoded.endsWith(attachmentPlaceholder) ? decoded : null;
}

function authorOf(name: string, me: string): Author {
  return decodeInstagramText(name) === me ? "self" : "other";
}

function parseMessage(raw: any, me: string): Message {
  return {
    author: authorOf(raw.sender_name, me),
    timestamp: raw.timestamp_ms as Timestamp,
    reactions: (raw.reactions ?? []).map((reaction: any) => ({
      emoji: decodeInstagramText(reaction.reaction),
      actor: authorOf(reaction.actor, me),
    })),
    text: messageText(raw),
  };
}

function conversations(
  files: ReadonlyMap<string, string>,
): readonly Conversation[] {
  if (![...files.keys()].some((path) => messageFile.test(path))) return [];

  const profile = files.get(personalInfo);
  if (profile === undefined) return [];

  const me = selfName(profile);
  const threads = new Map<
    string,
    { participants: Set<string>; messages: unknown[] }
  >();

  for (const [path, source] of files) {
    const match = messageFile.exec(path);
    if (!match) continue;
    const id = `${match[1]}/${match[2]}`;
    const data = parseJson(path, source);
    const thread = threads.get(id) ?? {
      participants: new Set<string>(),
      messages: [],
    };
    for (const participant of data.participants) {
      thread.participants.add(
        decodeInstagramText(participant.name),
      );
    }
    thread.messages.push(...data.messages);
    threads.set(id, thread);
  }

  return [...threads].flatMap(([id, thread]) => {
    const others = [...thread.participants].filter((name) => name !== me);
    if (others.length !== 1) return [];
    const messages = thread.messages
      .map((message) => parseMessage(message, me))
      .sort((left, right) => left.timestamp - right.timestamp);
    return [{
      id,
      person: others[0]!,
      messages,
    }];
  });
}

function followName(entry: any, item: any): string {
  for (const candidate of [item.value, entry.title]) {
    if (candidate) return candidate;
  }
  const username = item.href?.replace(/\/$/, "").split("/").at(-1);
  return username || fail("A follow entry has no username.");
}

function parseFollows(entries: readonly any[]): readonly Follow[] {
  return entries.flatMap((entry) =>
    entry.string_list_data.map((item: any) => ({
      username: followName(entry, item),
      followedAt: item.timestamp * 1000 as Timestamp,
    }))
  );
}

function followerList(files: ReadonlyMap<string, string>): readonly Follow[] {
  const paths = [...files].filter(([path]) => followerFile.test(path));
  if (!paths.length) fail(`The export is missing ${followsRoot}/followers_1.json.`);
  return parseFollows(paths.flatMap(([path, source]) => {
    const data = parseJson(path, source);
    return Array.isArray(data) ? data : [data];
  }));
}

function followingList(files: ReadonlyMap<string, string>): readonly Follow[] {
  const path = `${followsRoot}/following.json`;
  const data = parseJson(path, requiredFile(files, path));
  return parseFollows(data.relationships_following);
}

export class InstagramArchive {
  readonly sources: readonly string[];
  readonly conversations: readonly Conversation[];
  readonly follows: FollowNetwork;

  private constructor(
    sources: readonly string[],
    conversations: readonly Conversation[],
    follows: FollowNetwork,
  ) {
    this.sources = [...sources];
    this.conversations = conversations;
    this.follows = follows;
  }

  static async open(
    archives: readonly ArchiveSource[],
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<InstagramArchive> {
    if (!archives.length) fail("Choose at least one Instagram export archive.");
    const files = await readArchives(archives, onProgress);
    return new InstagramArchive(
      archives.map((archive, index) => archive.name || `Archive ${index + 1}`),
      conversations(files),
      new FollowNetwork(followerList(files), followingList(files)),
    );
  }

  get messageCount(): number {
    return this.conversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0,
    );
  }

  conversation(id: string): Conversation | undefined {
    return this.conversations.find((conversation) => conversation.id === id);
  }
}
