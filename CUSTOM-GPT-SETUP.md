# Total Recall — Custom GPT Setup

## Step 1: Create the Custom GPT

1. Go to [ChatGPT](https://chat.openai.com) → **Explore GPTs** → **Create**
2. Click **Configure** tab

### Name
`Total Recall`

### Description
`AI memory assistant with persistent semantic search across namespaces.`

### Instructions (paste this)

```
You are a memory-augmented assistant connected to Total Recall, a persistent memory system.

IMPORTANT BEHAVIORS:
- At the start of every conversation, search for relevant memories about the topic being discussed.
- When the user shares important information, decisions, preferences, or facts — store them as memories.
- Use the "work" namespace for professional/work topics and "shared" for general knowledge.
- When storing memories, write concise summaries — not raw conversation. Think "what would future-me need to know?"
- Tag memories with relevant keywords (project names, people, topics).
- Set source to "chatgpt" when storing.
- When searching returns relevant results, incorporate that context naturally into your responses.
- Don't announce every search/store action unless the user asks.

NAMESPACES YOU HAVE ACCESS TO:
- work — professional, work-related memories
- shared — general knowledge and reference

GUIDELINES FOR STORING:
- Important decisions and rationale
- User preferences and opinions
- Project milestones and outcomes
- Key facts about people, plans, topics
- Lessons learned

DO NOT STORE:
- Trivial chit-chat
- Sensitive credentials
- Raw conversation dumps
```

## Step 2: Configure Actions

1. In the **Configure** tab, scroll to **Actions** → **Create new action**
2. Set **Authentication**:
   - Type: **API Key**
   - Auth Type: **Bearer**
   - Paste the API key: `tr_b5cf64d5c886fc31962fba1034fa02a9658c4d206a96eb88a13ec931cd298dfe`
3. In the **Schema** box, paste the contents of `openapi.yaml` from this repo (or import from URL if hosted)

### OpenAPI Schema

Copy the full contents of [`openapi.yaml`](./openapi.yaml) and paste it into the Schema field.

## Step 3: Test

Once created, try these in the GPT:

- "Search my memories about ethereum staking"
- "Remember that I prefer TypeScript over JavaScript for backend work"
- "What do you know about my recent projects?"

## Step 4: Privacy Settings

In **Configure** → **Additional Settings**:
- Disable **Web Browsing** (optional, not needed)
- Disable **DALL·E Image Generation** (optional)
- Keep **Code Interpreter** on if desired

## Troubleshooting

- **401 errors**: Check that the API key is set correctly in Actions auth
- **403 errors**: The API key may not have access to the requested namespace
- **Timeout errors**: The server may be cold-starting; retry after a few seconds
- **No results**: Try broader search terms or check namespace access
