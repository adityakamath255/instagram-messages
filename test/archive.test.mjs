import assert from "node:assert/strict";
import test from "node:test";

import {
  BlobWriter,
  TextReader,
  ZipWriter,
} from "@zip.js/zip.js";

import {
  decodeInstagramText,
  ExportError,
  InstagramArchive,
  trends,
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
  assert.equal(data.hasMessages, true);
  assert.equal(data.conversations.length, 1);
  assert.equal(data.conversations[0].id, "inbox/ana_1");
  assert.equal(data.conversations[0].person, "Ana");
  assert.equal(data.conversations[0].messageCount, 2);
  assert.equal(data.conversation("inbox/ana_1"), data.conversations[0]);
  const conversation = data.conversations[0];
  const overview = data.overview("Messages");
  const messageReport = conversation.report("Messages");
  const characterReport = conversation.report("Characters");
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
  const reactions = [{
    emoji: "😂",
    self: 0,
    other: 1,
  }];
  assert.deepEqual(data.reactions(), reactions);
  assert.deepEqual(conversation.reactions(), reactions);

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

test("loads follow data without message or profile data", async () => {
  const files = completeExport();
  const followFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) =>
      path === followersPath || path === followingPath
    ),
  );

  const data = await InstagramArchive.open([await archive(followFiles)]);

  assert.equal(data.hasMessages, false);
  assert.deepEqual(data.conversations, []);
  assert.deepEqual(
    data.follows.group("you-follow").map(({ username }) => username),
    ["lee"],
  );
});

test("loads message data without follow data", async () => {
  const files = completeExport();
  const messageFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) =>
      path === personalPath || path === messagePath
    ),
  );

  const data = await InstagramArchive.open([await archive(messageFiles)]);

  assert.equal(data.hasMessages, true);
  assert.equal(data.conversations.length, 1);
  assert.equal(data.follows, null);
  assert.equal(data.overview("Messages").byAuthor.self, 1);
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

test("rejects incomplete follow data", async () => {
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

test("rejects message data without personal information", async () => {
  const messages = await archive({
    [messagePath]: completeExport()[messagePath],
  });

  await assert.rejects(
    InstagramArchive.open([messages]),
    (error) =>
      error instanceof ExportError &&
      error.message.includes("personal_information.json"),
  );
});
