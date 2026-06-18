import calendar
import io
import json
import zipfile
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone, tzinfo
from itertools import accumulate
from pathlib import Path
from typing import Literal, TypeVar


def decode(s: str) -> str:
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


Author = Literal["self", "other"]


@dataclass(frozen=True)
class Reaction:
    emoji: str
    actor: Author


@dataclass(frozen=True)
class Message:
    author: Author
    timestamp: datetime
    reactions: Sequence[Reaction]
    text: str | None


@dataclass(frozen=True)
class Chat:
    person: str
    messages: Sequence[Message]


PLACEHOLDER = "sent an attachment."
MEDIA_KEYS = ("photos", "videos")


def has_media(raw: Mapping) -> bool:
    return any(raw.get(key) for key in MEDIA_KEYS)


def message_text(raw: Mapping) -> str | None:
    blocked = (
        raw.get("is_unsent")
        or raw.get("call_duration") is not None
        or raw.get("audio_files")
        or has_media(raw)
    )
    if blocked:
        return None
    content = decode(raw.get("content", ""))
    return content if content and not content.endswith(PLACEHOLDER) else None


def author_of(name: str, me: str) -> Author:
    return "self" if decode(name) == me else "other"


def parse_message(raw: dict, me: str) -> Message:
    return Message(
        author=author_of(raw["sender_name"], me),
        timestamp=datetime.fromtimestamp(
            raw["timestamp_ms"] / 1000,
            tz=timezone.utc
        ),
        reactions=[
            Reaction(decode(r["reaction"]), author_of(r["actor"], me))
            for r in raw.get("reactions", [])
        ],
        text=message_text(raw),
    )


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


MESSAGES_DIR = Path("your_instagram_activity") / "messages"
PERSONAL_INFO = (
    Path("personal_information")
    / "personal_information"
    / "personal_information.json"
)
FOLLOWS_DIR = Path("connections") / "followers_and_following"

EXPORT_MARKERS = (
    "your_instagram_activity", "connections", "personal_information"
)


def find_root(base: Path) -> Path | None:
    directories = (p for p in base.rglob("*") if p.is_dir())
    candidates = [
        d
        for d in (base, *directories)
        if any((d / marker).is_dir() for marker in EXPORT_MARKERS)
    ]
    return min(candidates, key=lambda d: len(d.parts), default=None)


def extract_export(payloads: Iterable[bytes], dest: Path) -> Path | None:
    for data in payloads:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            archive.extractall(dest)
    return find_root(dest)


def self_name(export: Path) -> str:
    profile = read_json(export / PERSONAL_INFO)["profile_user"][0]
    info = profile["string_map_data"]
    field = info.get("Name") or info["Username"]
    return decode(field["value"])


def read_threads(export: Path) -> Iterator[tuple[set[str], list[dict]]]:
    for folder in ("inbox", "message_requests"):
        base = export / MESSAGES_DIR / folder
        if not base.is_dir():
            continue
        for directory in sorted(base.iterdir()):
            participants: set[str] = set()
            messages: list[dict] = []
            for file in sorted(directory.glob("message_*.json")):
                data = read_json(file)
                participants.update(
                    decode(p["name"]) for p in data["participants"]
                )
                messages.extend(data["messages"])
            if messages:
                yield participants, messages


def load(export: Path) -> list[Chat]:
    me = self_name(export)
    chats = []
    for participants, raw_messages in read_threads(export):
        others = participants - {me}
        if len(others) != 1:
            continue
        (person,) = others
        messages = sorted(
            (parse_message(m, me) for m in raw_messages),
            key=lambda m: m.timestamp,
        )
        chats.append(Chat(person, messages))
    return chats


Measure = Callable[[Message], int]


def count(_: Message) -> int:
    return 1


def characters(m: Message) -> int:
    return len(m.text or "")


MEASURES: Mapping[str, Measure] = {
    "messages": count,
    "characters": characters,
}


K = TypeVar("K")


def tally(
    messages: Iterable[Message],
    key: Callable[[Message], K],
    measure: Measure,
) -> dict[K, int]:
    totals: dict[K, int] = defaultdict(int)
    for m in messages:
        totals[key(m)] += measure(m)
    return dict(totals)


def distribution(
    messages: Iterable[Message],
    key: Callable[[Message], K],
    measure: Measure,
    domain: Iterable[K],
) -> dict[K, int]:
    counts = tally(messages, key, measure)
    return {value: counts.get(value, 0) for value in domain}


def when(tz: tzinfo, of: Callable[[datetime], K]) -> Callable[[Message], K]:
    return lambda m: of(m.timestamp.astimezone(tz))


def reactions_by_actor(
    messages: Iterable[Message],
) -> dict[tuple[str, Author], int]:
    return dict(Counter(
        (r.emoji, r.actor) for m in messages for r in m.reactions
    ))


def cumulative(series: Mapping[date, int]) -> dict[date, int]:
    days = sorted(series)
    return dict(zip(days, accumulate(series[d] for d in days)))


def total(messages: Iterable[Message], measure: Measure) -> int:
    return sum(measure(m) for m in messages)


def by_author(
    messages: Iterable[Message], measure: Measure
) -> dict[Author, int]:
    return tally(messages, lambda m: m.author, measure)


def by_hour(
    messages: Iterable[Message], measure: Measure, tz: tzinfo
) -> dict[int, int]:
    return distribution(
        messages, when(tz, lambda t: t.hour), measure, range(24)
    )


def by_weekday(
    messages: Iterable[Message], measure: Measure, tz: tzinfo
) -> dict[str, int]:
    return distribution(
        messages,
        when(tz, lambda t: calendar.day_abbr[t.weekday()]),
        measure,
        calendar.day_abbr,
    )


def daily(
    messages: Iterable[Message], measure: Measure, tz: tzinfo
) -> dict[date, int]:
    return dict(
        sorted(tally(messages, when(tz, lambda t: t.date()), measure).items())
    )


@dataclass(frozen=True)
class Follow:
    username: str
    at: datetime


def follow_name(entry: dict, item: dict) -> str:
    return (
        item.get("value")
        or entry.get("title")
        or item["href"].rstrip("/").rsplit("/", 1)[-1]
    )


def parse_follows(entries: Iterable[dict]) -> list[Follow]:
    return [
        Follow(
            follow_name(entry, item),
            datetime.fromtimestamp(item["timestamp"], tz=timezone.utc),
        )
        for entry in entries
        for item in entry["string_list_data"]
    ]


def read_entries(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    return data if isinstance(data, list) else [data]


def followers(export: Path) -> list[Follow]:
    base = export / FOLLOWS_DIR
    return parse_follows(
        entry
        for file in sorted(base.glob("followers_*.json"))
        for entry in read_entries(file)
    )


def following(export: Path) -> list[Follow]:
    data = read_json(export / FOLLOWS_DIR / "following.json")
    return parse_follows(data["relationships_following"])


def profile_url(follow: Follow) -> str:
    return f"https://www.instagram.com/{follow.username}"


@dataclass(frozen=True)
class Reciprocity:
    mutual: Sequence[Follow]
    you_follow_only: Sequence[Follow]
    follows_you_only: Sequence[Follow]


def reciprocity(
    followers: Sequence[Follow], following: Sequence[Follow]
) -> Reciprocity:
    follower_names = {f.username for f in followers}
    following_names = {f.username for f in following}
    return Reciprocity(
        mutual=[
            f for f in following if f.username in follower_names
        ],
        you_follow_only=[
            f for f in following if f.username not in follower_names
        ],
        follows_you_only=[
            f for f in followers if f.username not in following_names
        ],
    )


def labels(chats: Sequence[Chat]) -> list[str]:
    by_name = Counter(c.person for c in chats)
    used: Counter[str] = Counter()
    result: list[str] = []
    for chat in chats:
        base = (
            chat.person 
            if by_name[chat.person] == 1 
            else f"{chat.person} ({len(chat.messages)})"
        )
        used[base] += 1
        result.append(base if used[base] == 1 else f"{base} #{used[base]}")
    return result
