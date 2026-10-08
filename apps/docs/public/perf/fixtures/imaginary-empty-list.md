# Imaginary Empty Nested List

This fixture isolates the regression where an ordered list item briefly committed an empty nested list shell.

1. **Prepare your dataset**: Make sure your dataset is in a usable format for a Naive Bayes classifier.
2. **Split your dataset into training and testing sets**: Estimate parameters on the training portion and evaluate on the testing portion.
3. **Estimate the parameters of the classifier**: This item used to provoke an empty nested list shell under streaming when the boundary to the next item landed at the wrong time.<!--split-->
4. **Predict labels for new instances**: Use the estimated parameters to classify new examples and verify that the ordered list continues cleanly with no empty nested list under item three.
