// Test TTY detection in a real cmd
import process from 'node:process'
console.log('stdin.isTTY:', process.stdin.isTTY)
console.log('stdout.isTTY:', process.stdout.isTTY)
console.log('argv0:', process.argv0)
if (process.stdin.isTTY) {
  console.log('TTY mode: would setRawMode and read keystrokes')
} else {
  console.log('Non-TTY: would drain stdin buffer')
}
