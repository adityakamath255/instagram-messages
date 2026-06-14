import calendar
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from tkinter import Tk, filedialog

import pandas as pd
import streamlit as st

from core import (
    Chat,
    Follow,
    MEASURES,
    Message,
    author,
    count,
    cumulative,
    day,
    followers,
    following,
    follows_by_day,
    hour,
    kind,
    labels,
    load,
    profile_url,
    reaction_emojis,
    reciprocity,
    tally,
    weekday,
)


def pick_folder() -> str:
    root = Tk()
    root.withdraw()
    root.wm_attributes("-topmost", True)
    folder = filedialog.askdirectory()
    root.destroy()
    return folder


def main() -> None:
    st.set_page_config(page_title="Instagram", layout="wide")
    st.title("Instagram")
    tz = datetime.now().astimezone().tzinfo or timezone.utc

    @st.cache_data
    def get_chats(export: str) -> list[Chat]:
        return load(Path(export))

    @st.cache_data
    def get_follows(export: str) -> tuple[list[Follow], list[Follow]]:
        base = Path(export)
        return followers(base), following(base)

    def messages_view(export: str) -> None:
        name = st.sidebar.selectbox("Measure", list(MEASURES))
        measure = MEASURES[name]
        unit = name.title()

        chats = sorted(
            get_chats(export), 
            key=lambda c: len(c.messages), reverse=True
        )
        chosen = dict(zip(labels(chats), chats))
        who = st.sidebar.selectbox("Person", ["Everyone", *chosen])

        def ranked(title: str, data: Mapping[str, int]) -> None:
            if data:
                st.subheader(title)
                st.bar_chart(pd.Series(data).sort_values(ascending=False))

        def hourly(messages: Iterable[Message]) -> None:
            counts = tally(messages, hour(tz), measure)
            st.subheader(f"{unit} by hour of day")
            st.bar_chart(pd.Series(counts).reindex(range(24), fill_value=0))

        def weekly(messages: Iterable[Message]) -> None:
            counts = tally(messages, weekday(tz), measure)
            series = pd.Series(counts).reindex(range(7), fill_value=0)
            series.index = list(calendar.day_abbr)
            st.subheader(f"{unit} by day of week")
            st.bar_chart(series)

        def composition(messages: Iterable[Message]) -> None:
            ranked("Message composition", tally(messages, kind, count))

        def reactions(messages: Iterable[Message]) -> None:
            ranked("Top reactions", reaction_emojis(messages))

        if who == "Everyone":
            everyone = [m for c in chosen.values() for m in c.messages]
            totals = {
                label: sum(map(measure, c.messages))
                for label, c in chosen.items()
            }
            ranked(f"{unit} per person", totals)
            hourly(everyone)
            weekly(everyone)
            composition(everyone)
            reactions(everyone)
            return

        chat = chosen[who]
        split = tally(chat.messages, author, measure)
        you, them = st.columns(2)
        you.metric("You", split.get("self", 0))
        them.metric(chat.person, split.get("other", 0))

        hourly(chat.messages)
        weekly(chat.messages)

        st.subheader(f"{unit} over time")
        view = st.radio(
            "View",
            ["Daily", "Cumulative"],
            horizontal=True,
            label_visibility="collapsed"
        )
        daily = tally(chat.messages, day(tz), measure)
        series = cumulative(daily) if view == "Cumulative" else daily
        st.line_chart(pd.Series(series).sort_index())

        composition(chat.messages)
        reactions(chat.messages)

    def follows_view(export: str) -> None:
        follower_list, following_list = get_follows(export)

        growth = pd.DataFrame({
            "followers": pd.Series(follows_by_day(follower_list, tz)),
            "following": pd.Series(follows_by_day(following_list, tz)),
        }).fillna(0).sort_index().cumsum()
        st.subheader("Follow growth")
        st.line_chart(growth)

        rec = reciprocity(follower_list, following_list)
        groups = {
            "Mutual": rec.mutual,
            "You follow, no follow-back": rec.you_follow_only,
            "Follows you, not followed back": rec.follows_you_only,
        }
        pick = st.sidebar.radio("Group", list(groups))
        group = groups[pick]
        st.subheader(f"{pick} ({len(group)})")
        st.dataframe(
            pd.DataFrame(
                {
                    "username": f.username, 
                    "profile": profile_url(f), 
                    "since": f.at.date()
                }
                for f in group
            ),
            hide_index=True,
            column_config={"profile": st.column_config.LinkColumn()},
        )

    if st.sidebar.button("Choose export folder"):
        chosen = pick_folder()
        if chosen:
            st.session_state.export = chosen
    export = st.session_state.get("export", "")

    if not (Path(export) / "messages").is_dir():
        st.info("Choose the folder of an unzipped Instagram data export.")
        st.stop()
    st.sidebar.caption(export)

    section = st.sidebar.radio("View", ["Messages", "Follows"])
    (messages_view if section == "Messages" else follows_view)(export)


if __name__ == "__main__":
    main()
