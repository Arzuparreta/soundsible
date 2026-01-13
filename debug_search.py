
from setup_tool.metadata import search_itunes

filename = "Halo 3 ODST_Original Soundtrack - 04 Rain (Deference for Darkness)"
clean_1 = filename.replace('_', ' ').replace('-', ' ')

print(f"Query 1: '{clean_1}'")
results = search_itunes(clean_1, limit=5)
print(f"Results: {len(results)}")
for r in results:
    print(f" - {r['artist']} - {r['title']} ({r['album']})")

# Try smarter cleaning
import re
# Remove track numbers at start "04 "
clean_2 = re.sub(r'^\d+\s+', '', clean_1.strip())
# Remove "Original Soundtrack"
clean_2 = clean_2.replace("Original Soundtrack", "")
# Remove extra spaces
clean_2 = " ".join(clean_2.split())

print(f"\nQuery 2: '{clean_2}'")
results_2 = search_itunes(clean_2, limit=5)
print(f"Results: {len(results_2)}")
for r in results_2:
    print(f" - {r['artist']} - {r['title']} ({r['album']})")
