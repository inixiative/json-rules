#!/bin/bash

echo "Running all examples..."
echo

for file in examples/*.ts; do
    filename=$(basename "$file")
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Running: $filename"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    bun "$file"
    echo
done

echo "All examples completed!"