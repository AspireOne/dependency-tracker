# deplic

A TypeScript package that generates a readable document of project dependencies with their licenses, and makes sure all licences are permissive.

## Installation
npm install deplic

## Usage

Just run "pnpm deplic" from the root of your project, and a "dependencies.md" file will be created, with dependencies cached for one week.

You can use this in a pre-commit hook.