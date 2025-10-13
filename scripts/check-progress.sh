#!/bin/bash

# Check if regenerate-summaries-bulk is running
if ps aux | grep -q "[r]egenerate-summaries-bulk"; then
    echo "✓ Regeneration script is running"

    # Get the latest progress from the log
    if [ -f regenerate-log.txt ]; then
        echo ""
        echo "Latest progress:"
        tail -200 regenerate-log.txt | grep "Processing story" | tail -1

        echo ""
        echo "Latest summaries:"
        tail -50 regenerate-log.txt | grep -E "(Post summary written|Comments summary written)" | tail -5

        echo ""
        echo "Any errors:"
        tail -100 regenerate-log.txt | grep -i "error\|failed\|rate limit" | tail -5

        echo ""
        echo "To view full log: tail -f regenerate-log.txt"
    else
        echo "Log file not found"
    fi
else
    echo "✗ Regeneration script is not running"

    if [ -f regenerate-log.txt ]; then
        echo ""
        echo "Final status from log:"
        tail -20 regenerate-log.txt | grep -E "(complete|Failed|Rate limit)"
    fi
fi


