import json
import sys

from ddgs import DDGS


def main() -> None:
    request = json.load(sys.stdin)
    query = str(request["query"]).strip()
    count = min(max(int(request["count"]), 1), 10)
    results = DDGS(timeout=10).text(
        query,
        region=str(request.get("region") or "zh-cn"),
        safesearch=str(request.get("safeSearch") or "moderate"),
        timelimit=request.get("timeLimit"),
        max_results=count,
    )
    json.dump(results, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
