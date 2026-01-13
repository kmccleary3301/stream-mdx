### Incremental Code Highlighting

```js
const label = "incremental";
const items = [
  "alpha",
  "beta",
  "gamma",
];

function format(list) {
  /* multi-line
     comment */
  return list.map((value, index) => `${index + 1}: ${value}`);
}

console.log(format(items));
```
