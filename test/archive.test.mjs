import assert from "node:assert/strict";
import test from "node:test";

import {
  BlobWriter,
  TextReader,
  ZipWriter,
} from "@zip.js/zip.js";

import {
  ArchiveAnalysis,
  trends,
} from "../src/analysis.ts";
import {
  decodeInstagramText,
  ExportError,
  InstagramArchive,
} from "../src/archive.ts";

async function archive(files) {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const [path, data] of Object.entries(files)) {
    await writer.add(path, new TextReader(JSON.stringify(data)));
  }
  return writer.close();
}

const root = "instagram-sample-2026-01-01/";
const personalPath =
  `${root}personal_information/personal_information/personal_information.json`;
const messagePath =
  `${root}your_instagram_activity/messages/inbox/ana_1/message_1.json`;
const followersPath =
  `${root}connections/followers_and_following/followers_1.json`;
const followingPath =
  `${root}connections/followers_and_following/following.json`;

function completeExport() {
  return {
    [personalPath]: {
      profile_user: [{
        string_map_data: {
          Name: { value: "JosÃ©" },
        },
      }],
    },
    [messagePath]: {
      participants: [{ name: "JosÃ©" }, { name: "Ana" }],
      messages: [
        {
          sender_name: "JosÃ©",
          timestamp_ms: 1_700_000_000_000,
          content: "hello",
          reactions: [{ reaction: "ð", actor: "Ana" }],
        },
        {
          sender_name: "Ana",
          timestamp_ms: 1_700_000_001_000,
          content: "👋",
        },
      ],
    },
    [followersPath]: [
      {
        string_list_data: [{
          value: "ana",
          href: "https://www.instagram.com/ana/",
          timestamp: 1_600_000_000,
        }],
      },
      {
        string_list_data: [{
          value: "sam",
          href: "https://www.instagram.com/sam/",
          timestamp: 1_600_000_100,
        }],
      },
    ],
    [followingPath]: {
      relationships_following: [
        {
          title: "ana",
          string_list_data: [{
            href: "https://www.instagram.com/ana/",
            timestamp: 1_600_000_200,
          }],
        },
        {
          title: "lee",
          string_list_data: [{
            href: "https://www.instagram.com/lee/",
            timestamp: 1_600_000_300,
          }],
        },
      ],
    },
  };
}

test("loads and analyzes a complete archive", async () => {
  const data = await InstagramArchive.open([await archive(completeExport())]);

  assert.equal(decodeInstagramText("JosÃ©"), "José");
  assert.deepEqual(data.sources, ["Archive 1"]);
  assert.equal(data.conversations.length, 1);
  assert.equal(data.conversations[0].id, "inbox/ana_1");
  assert.equal(data.conversations[0].person, "Ana");
  assert.equal(data.conversation("inbox/ana_1"), data.conversations[0]);
  assert.equal(data.conversations[0].messages[0].author, "self");
  assert.equal(data.conversations[0].messages[0].reactions[0].emoji, "😂");
  const analysis = new ArchiveAnalysis(data);
  const conversation = data.conversations[0];
  const overview = analysis.overview("Messages");
  const messageReport = analysis.conversation(conversation, "Messages");
  const characterReport = analysis.conversation(conversation, "Characters");
  assert.deepEqual(overview.conversationTotals, [{
    label: "Ana",
    value: 2,
  }]);
  assert.deepEqual(overview.byAuthor, { self: 1, other: 1 });
  assert.equal(
    messageReport.byAuthor.self + messageReport.byAuthor.other,
    2,
  );
  assert.deepEqual(messageReport.byAuthor, { self: 1, other: 1 });
  assert.equal(
    characterReport.byAuthor.self + characterReport.byAuthor.other,
    6,
  );
  assert.deepEqual(
    trends.Monthly(characterReport).map(({ value }) => value),
    [6],
  );
  assert.deepEqual(
    trends.Cumulative(characterReport).map(({ value }) => value),
    [6],
  );
  assert.deepEqual(messageReport.reactions, [{
    emoji: "😂",
    self: 0,
    other: 1,
  }]);

  assert.deepEqual(
    data.follows.group("mutual").map(({ username }) => username),
    ["ana"],
  );
  assert.deepEqual(
    data.follows.group("you-follow").map(({ username }) => username),
    ["lee"],
  );
  assert.deepEqual(
    data.follows.group("follows-you").map(({ username }) => username),
    ["sam"],
  );
});

test("combines split archives", async () => {
  const files = completeExport();
  const entries = Object.entries(files);
  const first = Object.fromEntries(entries.slice(0, 2));
  const second = Object.fromEntries(entries.slice(2));

  const data = await InstagramArchive.open([
    await archive(first),
    await archive(second),
  ]);

  assert.equal(data.conversations.length, 1);
  assert.equal(data.follows.followerCount, 2);
  assert.equal(data.follows.followingCount, 2);
});

test("rejects conflicting files across archives", async () => {
  const first = await archive({
    [personalPath]: { profile_user: [] },
  });
  const second = await archive({
    [personalPath]: { profile_user: [{ string_map_data: {} }] },
  });

  await assert.rejects(
    InstagramArchive.open([first, second]),
    (error) =>
      error instanceof ExportError &&
      error.message.includes("conflicting copies"),
  );
});

test("rejects an incomplete export", async () => {
  const incomplete = Object.fromEntries(
    Object.entries(completeExport()).filter(([path]) => path !== followingPath),
  );

  await assert.rejects(
    InstagramArchive.open([await archive(incomplete)]),
    (error) =>
      error instanceof ExportError &&
      error.message.includes("following.json"),
  );
});

test("rejects duplicate follow identities", async () => {
  const complete = completeExport();
  const duplicate = {
    ...complete,
    [followersPath]: [
      ...complete[followersPath],
      {
        string_list_data: [{
          value: "sam",
          href: "https://www.instagram.com/sam/",
          timestamp: 1_600_000_400,
        }],
      },
    ],
  };

  await assert.rejects(
    InstagramArchive.open([await archive(duplicate)]),
    (error) =>
      error instanceof ExportError &&
      error.message.includes("more than one follow entry"),
  );
});

test("rejects malformed optional message fields", async () => {
  const complete = completeExport();
  complete[messagePath].messages[0].photos = {};

  await assert.rejects(
    InstagramArchive.open([await archive(complete)]),
    (error) =>
      error instanceof ExportError &&
      error.message.includes("message photos is not a list"),
  );
});

test("rejects invalid timestamps", async () => {
  const invalidMessage = completeExport();
  invalidMessage[messagePath].messages[0].timestamp_ms = Number.MAX_SAFE_INTEGER;

  await assert.rejects(
    InstagramArchive.open([await archive(invalidMessage)]),
    (error) =>
      error instanceof ExportError &&
      error.message.includes("message timestamp is not a valid timestamp"),
  );

  const invalidFollow = completeExport();
  invalidFollow[followersPath][0].string_list_data[0].timestamp =
    Number.MAX_SAFE_INTEGER;

  await assert.rejects(
    InstagramArchive.open([await archive(invalidFollow)]),
    (error) =>
      error instanceof ExportError &&
      error.message.includes("follow timestamp is not a valid timestamp"),
  );
});
