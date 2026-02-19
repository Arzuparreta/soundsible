#!/usr/bin/env python3
"""Clean leftover text in ODST plan file."""
import re

path = "/home/arsu/.cursor/plans/odst_frontend_rework_plan_b272b215.plan.md"
with open(path, "r", encoding="utf-8") as f:
    s = f.read()

# Remove trailing junk after "status API." on Submit flow line
s = re.sub(r"(status API\.)[\u2018\u2019\u201c\u201d'\"]*Download selected[\u201c\u201d'\"]*\s*", r"\1\n", s)
# Remove "Download selected" / "Add X to queue") from Main bullet
s = re.sub(r"\s*[\u201c\u201d\"]Download selected[\u201c\u201d\"]\s*/\s*[\u201c\u201d\"]Add X to queue[\u201c\u201d\"]\)\s*", " ", s)
# Fix Search flow: remove duplicate "Download selected (or..." sentence
s = re.sub(r"User submits plain text\s+[\u201c\u201d\"]Download selected[\u201c\u201d\"]\s*\(or[\s\S]*?params\)\.\s*-", "User submits plain text → call `GET /api/downloader/youtube/search?q=...` → render results. Loading and \"No results\" / error states.\n-", s, count=1)
# Fix Submit flow: remove "Download" → before `POST
s = re.sub(r"[\u201c\u201d\"]Download[\u201c\u201d\"]\s*→\s*(?=`POST)", "", s)

with open(path, "w", encoding="utf-8") as f:
    f.write(s)
print("Plan cleaned.")
