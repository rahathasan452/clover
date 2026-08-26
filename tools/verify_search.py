import json
from pathlib import Path

index_path = Path("public/data/search_index.json")
if not index_path.exists():
    print("search_index.json does not exist")
    exit(1)

with open(index_path, "r", encoding="utf-8") as f:
    records = json.load(f)

print(f"Total indexed records: {len(records)}")

queries = ["candlestick", "moving average", "risk management", "position sizing"]
for q in queries:
    matches = [r for r in records if q in r["text"].lower()]
    unique_books = set(r["bookId"] for r in matches)
    print(f"\nQuery '{q}': {len(matches)} matches across {len(unique_books)} books")
    if matches:
        first = matches[0]
        print(f"  Sample hit: [{first['bookTitle']}] p.{first['page']}")
        clean_snip = first['text'][:90].encode('ascii', 'replace').decode('ascii')
        print(f"  Snippet: {clean_snip}...")
        if first.get("words"):
            print(f"  Word bbox count: {len(first['words'])}")
            w0 = first['words'][0]
            clean_w = str(w0['w']).encode('ascii', 'replace').decode('ascii')
            print(f"  First word bbox: word='{clean_w}', bbox={w0['b']}")
