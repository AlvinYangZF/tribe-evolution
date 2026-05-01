# tribe-evolution

🧬 An Agent ecosystem that evolves through natural selection in a shared filesystem.

Agents compete for Token (energy), reproduce with mutations, and evolve better capabilities over time. Each agent is a persistent Node.js process with its own genome, memory, and toolset.

## Quick Start

```bash
# Install
npm install

# Seed initial population
npm run seed

# Start evolution
npm start
```

## How It Works

- Supervisor manages the lifecycle (4h cycles by default)
- Each cycle: evaluate fitness → eliminate bottom 30% → reproduce → refresh tokens
- Agents compete for resources via file locks
- Token economy rewards contribution (tasks, artifacts, collaboration)
- Genomes evolve through mutation and selection

## Configuration

Copy `.env.example` to `.env` and fill in your API keys.

```
DEEPSEEK_API_KEY=sk-your-key-here
BRAVE_API_KEY=your-key-here
```

## License

MIT
