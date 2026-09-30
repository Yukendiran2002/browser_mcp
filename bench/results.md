| server | task | ok | calls | result tokens | est. input tokens | time (ms) |
|---|---|---|---|---|---|---|
| browser-mcp | shop | ✓ | 3 | 1274 | 22406 | 1004 |
| browser-mcp | login | ✓ | 2 | 254 | 14416 | 1354 |
| browser-mcp | extract | ✓ | 2 | 1025 | 15218 | 390 |
| browser-mcp | read | ✓ | 1 | 104 | 9429 | 333 |
| playwright-mcp | shop | ✓ | 5 | 6079 | 54546 | 2536 |
| playwright-mcp | login | ✓ | 5 | 578 | 32694 | 1928 |
| playwright-mcp | extract | ✓ | 7 | 7391 | 81006 | 2539 |
| playwright-mcp | read | ✓ | 2 | 753 | 16130 | 640 |
| chrome-devtools-mcp | shop | ✓ | 5 | 10380 | 65072 | 1369 |
| chrome-devtools-mcp | login | ✓ | 5 | 554 | 40493 | 1467 |
| chrome-devtools-mcp | extract | ✓ | 7 | 6179 | 86656 | 1814 |
| chrome-devtools-mcp | read | ✓ | 2 | 579 | 20096 | 769 |

| server | tools | schema tokens | success | calls | result tokens | est. input tokens | time (ms) |
|---|---|---|---|---|---|---|---|
| browser-mcp | 27 | 4592 | 4/4 | 8 | 2657 | 61469 | 3081 |
| playwright-mcp | 25 | 5026 | 4/4 | 19 | 14801 | 184376 | 7643 |
| chrome-devtools-mcp | 30 | 6423 | 4/4 | 19 | 17692 | 212317 | 5419 |
