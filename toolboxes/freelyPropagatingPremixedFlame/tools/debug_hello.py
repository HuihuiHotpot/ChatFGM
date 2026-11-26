"""ChatFGM debug example: echo a message as JSON without file or network access."""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="ChatFGM debug greeting tool.")
    parser.add_argument("--message", default="你好，ChatFGM", help="Text to echo.")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "ok",
                "marker": "CHATFGM_DEBUG_TOOL_OK",
                "message": args.message,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
