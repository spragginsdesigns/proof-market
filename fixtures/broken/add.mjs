const [a, b] = process.argv.slice(2).map(Number);
// bug: adds one too many
console.log(a + b + 1);
