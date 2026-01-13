*Please note that this is a test document for the markdown rendering components of QueryLake's frontend*


The Naive Bayes classifier is a simple probabilistic classifier that is based on Bayes' theorem. It is called "naive" because it assumes that the features are independent of each other, which is often not true in real-world datasets. Despite its simplicity, the Naive Bayes classifier has been shown to perform well in many applications, including text classification, image classification, and bioinformatics. In this set of notes, we will provide an overview of the Naive Bayes classifier, its strengths and weaknesses, and how it can be used in practice. 

The Naive Bayes classifier is a simple probabilistic classifier that is based on Bayes’ theorem. It is called “naive” because it assumes that the features are independent of each other, which is often not true in real-world datasets. Despite its simplicity, the Naive Bayes classifier has been shown to perform well in many applications, including text classification, image classification, and bioinformatics. Math Expressions: To understand how the Naive Bayes classifier works, let’s start by defining some mathematical notation. Let $X$ be the feature matrix, where each row represents a sample and each column represents a feature. Let $Y$ be the label vector, where each element $y_i$ represents the class of the $i^{th}$ sample. Let $p(x)$ be the prior probability distribution over the features, and let $p(y|x)$ be the conditional probability distribution over the function.

The Jacobian of a function is a matrix that represents the partial derivatives of the function's output variables with respect to its input variables. It is a powerful tool in multivariate calculus and is used in many areas of mathematics, science, and engineering. In mathematical notation, the Jacobian of a function $f: \mathbb{R}^n \to \mathbb{R}^m$ at a point $\mathbf{x} = (x_1, \ldots, x_n)$ is denoted by $\mathbf{J}_f(\mathbf{x})$ and has dimensions $m \times n$. Its entries are given by: $$\mathbf{J}_f(\mathbf{x}) = \begin{bmatrix} \frac{\partial f_1}{\partial x_1} & \frac{\partial f_1}{\partial x_2} & \cdots & \frac{\partial f_1}{\partial x_n} \\ \vdots & \vdots & \ddots & \vdots \\ \frac{\partial f_m}{\partial x_1} & \frac{\partial f_m}{\partial x_2} & \cdots & \frac{\partial f_m}{\partial x_n} \end{bmatrix}$$ where $f_i$ is the $i$th component of the vector-valued function $f$. The Jacobian can be used to linearize the behavior of a function near a point, which can be useful for optimization problems or other applications where you want to approximate the behavior of a function locally. It can also be used to compute the differential of a function, which is important in many areas of mathematics and physics.

## How does the Naive Bayes classifier work?
The Naive Bayes classifier works by estimating the probability of an instance belonging to each class given the feature values. The probability is calculated using Bayes' theorem, which states that the probability of a hypothesis (H) given some evidence (E) is equal to the probability of the evidence given the hypothesis multiplied by the prior probability of the hypothesis divided by the probability of all hypotheses: $$P(H|E) = \frac{P(E|H) \times P(H)}{P(E)}$$ In the case of the Naive Bayes classifier, the hypothesis is represented by a vector of probabilities for each class, and the evidence is represented by a vector of feature values. The Naive Bayes classifier uses a simple trick to simplify the calculation of the posterior probability of the classes given the features: it sets one of the probabilities to 1, effectively eliminating that class from consideration. This allows the classifier to focus on the remaining classes and calculate their probabilities more accurately. 
## Strengths of the Naive Bayes classifier
1. **Handling missing values**: The Naive Bayes classifier can handle missing values in the data, which is a common problem in many machine learning tasks. It simply ignores the missing values when calculating the probabilities.
2. **Scalability**: The Naive Bayes classifier is very scalable, as it only requires computing the probabilities of each class given the features for each instance. This makes it well-suited for large datasets where computational resources are limited.
3. **Interpretability**: The Naive Bayes classifier provides interpretable results, as the probabilities of each class given the features provide insight into how the classifier has made its prediction.
4. **Robustness**: The Naive Bayes classifier is robust to outliers and noisy data, as it calculates the probabilities based on the entire dataset rather than just the instances with the most extreme features.
5. **Flexibility**: The Naive Bayes classifier can be used for both binary and multiclass classification problems, and it can handle categorical variables directly without requiring any additional preprocessing steps.
## Weaknesses of the Naive Bayes classifier 
1. *Assumes independence*: The Naive Bayes classifier assumes that the features are independent of each other, which is often not true in real-world datasets. In fact, many datasets exhibit complex relationships between the features, which can lead to poor performance if these relationships are not captured. 
2. **Sensitivity to prior probabilities**: The Naive Bayes classifier relies heavily on the prior probabilities of the classes, which can have a significant impact on its performance. If the prior probabilities are not accurate or fair, the classifier may make suboptimal predictions.
3. **Lack of handling non-linear relationships**: The Naive Bayes classifier assumes linear relationships between the features and the classes, which can lead to poor performance when dealing with non-linear relationships. 
4. **Not suitable for high-dimensional data**: As the number of features increases, the computational complexity of the Naive Bayes classifier grows exponentially, making it less practical for very large datasets. 
5. **No ability to handle missing values**: While the Naive Bayes classifier can handle missing values in some cases, it does not provide any built-in mechanism for handling missing values in general. 
## How to use the Naive Bayes classifier in practice
To use the Naive Bayes classifier in practice, you will need to follow these steps:
1. **Prepare your dataset**: Make sure your dataset is in a format that can be used by the Naive Bayes classifier. This typically involves converting categorical variables into numerical variables using techniques such as one-hot encoding or label encoding.
2. **Split your dataset into training and testing sets**: Split your dataset into two parts: a training set that you will use to estimate the parameters of the classifier, and a testing set that you will use to evaluate the performance of the classifier.
3. **Estimate the parameters of the classifier**: Use the training set to estimate the parameters of the Naive Bayes classifier, including the prior probabilities of each class and the weights of the features.
4. **Predict the labels of new instances**: Use the estimated parameters and the testing set to predict the labels of new instances. In summary, the Naive Bayes classifier is a simple probabilistic classifier that can be useful in certain situations due to its ability to handle missing values and its scalability. However, it assumes independence between the features, which can lead to poor performance when dealing with complex relationships between the features. It also relies heavily on the prior probabilities of the classes, which can have a significant impact on its performance if they are not accurate or fair. As a result, it is important to carefully evaluate the performance of the Naive Bayes classifier on your specific dataset before using it in practice.

```python
import inspect
import re
from typing import Callable, List

async def run_function_safe(function_actual, kwargs):
    """
    Run function without the danger of unknown kwargs.
    """
    function_args = list(inspect.signature(function_actual).parameters.items())
    function_args = [arg[0] for arg in function_args]
    new_args = {}
    for key in function_args:
        if key in kwargs:
            new_args[key] = kwargs[key]
    
    # print("CREATED CLEAN ARGS", json.dumps(new_args, indent=4))
    
    if inspect.iscoroutinefunction(function_actual):
        return await function_actual(**new_args)
    else:
        return function_actual(**new_args)

def get_function_args(function : Callable, 
                      return_type_pairs : bool = False):
    """
    Get a list of strings for each argument in a provided function.
    """
    function_args = list(inspect.signature(function).parameters.items())
    if return_type_pairs:
        return function_args
    
    function_args = [arg[0] for arg in function_args]
    return function_args

def get_function_docstring(function : Callable) -> str:
    """
    Get the docstring for a function.
    """
    
    if function.__doc__ is None:
        return ""
    
    return re.sub(r"\n[\s]+", "\n", function.__doc__.strip())

def get_function_call_preview(function : Callable,
                              excluded_arguments : List[str] = None) -> str:
    """
    Get a string preview of the function call with arguments.
    """
    if excluded_arguments is None:
        excluded_arguments = []
    
    function_args = get_function_args(function, return_type_pairs=True)
    
    
    wrap_around_string = ",\n" + " " * (len(function.__name__) + 1)
    
    argument_string = "(%s)" % (wrap_around_string.join([str(pair[1]) for pair in function_args if str(pair[0]) not in excluded_arguments]))
    
    # return_type_hint = str(function.__annotations__.get('return', ''))
    
    docstring_segment = '\n\t'.join(get_function_docstring(function).split('\n'))
    
    docstring_segment = "\t\"\"\"\n\t" + docstring_segment + "\n\t\"\"\""
    
    return f"{function.__name__}{argument_string}\n{docstring_segment}"


if __name__ == "__main__":
    print(get_function_call_preview(get_function_call_preview))
```

| Hedge Fund         | Margin     | Portfolio Size (USD) | Location                 |
|--------------------|------------|----------------------|----------------------    |
| Bridgewater        | 25%        | $150 billion         | Westport, Connecticut    |
| Renaissance        | Not Public | $80 billion          | East Setauket, NY        |
| Man Group          | Not Public | $62 billion          | London, UK               |
| Millennium         | Not Public | $55 billion          | New York, NY             |
| AQR Capital        | Not Public | $50 billion          | Greenwich, Connecticut   |
| Two Sigma          | Not Public | $50 billion          | New York, NY             |
| Citadel            | Not Public | $35 billion          | Chicago, IL              |
| Elliott Management | Not Public | $34 billion          | New York, NY             |
| D.E. Shaw          | Not Public | $34 billion          | New York, NY             |
| BlackRock          | Not Public | $33 billion          | New York, NY             |



Sure, here's the Markdown example without using code blocks to demonstrate the features:

# Markdown Example

## Text Formatting

**Bold text**  
*Italic text*  
~~Strikethrough text~~  
[Hyperlink](https://www.example.com)  

## Lists

### Unordered List
- Item 1
- Item 2
  - Subitem 1
  - Subitem 2
    - Subitem 1
    - Subitem 2

### Ordered List
1. First item
2. Second item
   - Subitem A
   - Subitem B
2. Let's start miscounting
1. To test the CSS

## Headers

# Heading 1
## Heading 2
### Heading 3

## Blockquotes

> This is a blockquote.

## Code

Inline `code` can be added like this.

```
Code blocks can be inserted like this.
```

## Tables

| Column 1 | Column 2 |
|----------|----------|
| Row 1    | Cell 1   |
| Row 2    | Cell 2   |

## Images

![Alt text](https://via.placeholder.com/150 "Image Title")

## Horizontal Line

---

## Line Break

Text above  
Text below

## Escaping Characters

\*Escaping\*

This Markdown example demonstrates various formatting features like text formatting, lists, headers, blockquotes, code blocks, tables, images, horizontal lines, line breaks, and escaping characters. You can use these features to create well-structured and visually appealing documents or posts in Markdown-supported platforms like GitHub, Reddit, or Stack Overflow.


```python
from sklearn.naive_bayes import GaussianNB
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score

# Sample dataset
X = [[1, 2], [2, 3], [3, 4], [4, 5]]  # Features
y = [0, 0, 1, 1]  # Labels

# Splitting the dataset into training and testing sets
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Initialize the Gaussian Naive Bayes classifier
clf = GaussianNB()

# Train the classifier
clf.fit(X_train, y_train)

# Make predictions on the testing set
y_pred = clf.predict(X_test)

# Calculate accuracy
accuracy = accuracy_score(y_test, y_pred)
print("Accuracy:", accuracy)
```

<h1>Hi</h1>

```json
{
	"split": "none",
	"size": 100,
	"align": "center",
	"tailwind": "w-[85vw] md:w-[70vw] lg:w-[60vw] xl:w-[50vw]",
	"mappings": [
		{
			"display_route": [
				"chat_history"
			],
			"display_as": "chat"
		}
	],
	"footer": {
		"align": "justify",
		"tailwind": "pb-2",
		"mappings": [
			{
				"display_as": "chat_input",
				"hooks": [
					{
						"hook": "on_submit",
						"target_event": "user_question_event",
						"target_route": "question",
						"store": false
					}
				],
				"config": [],
				"tailwind": "w-[85vw] md:w-[70vw] lg:w-[60vw] xl:w-[50vw]"
			}
		]
	}
}
```


### Container Overflow Test

$$
R_{\rho\sigma\mu\nu} = \frac{1}{2} \left( \frac{\partial^{2} g_{\rho\nu}}{\partial x^\sigma \partial x^\mu} + \frac{\partial^{2} g_{\sigma\mu}}{\partial x^\rho \partial x^\nu} - \frac{\partial^{2} g_{\rho\mu}}{\partial x^\sigma \partial x^\nu} - \frac{\partial^{2} g_{\sigma\nu}}{\partial x^\rho \partial x^\mu} \right) + g^{\lambda\kappa} \left( \Gamma_{\rho\sigma\lambda} \Gamma_{\mu\nu\kappa} - \Gamma_{\rho\nu\lambda} \Gamma_{\sigma\mu\kappa} \right) = \frac{1}{2} \left( \frac{\partial^{2} g_{\rho\nu}}{\partial x^\sigma \partial x^\mu} + \frac{\partial^{2} g_{\sigma\mu}}{\partial x^\rho \partial x^\nu} - \frac{\partial^{2} g_{\rho\mu}}{\partial x^\sigma \partial x^\nu} - \frac{\partial^{2} g_{\sigma\nu}}{\partial x^\rho \partial x^\mu} \right) + g^{\lambda\kappa} \left( \Gamma_{\rho\sigma\lambda} \Gamma_{\mu\nu\kappa} - \Gamma_{\rho\nu\lambda} \Gamma_{\sigma\mu\kappa} \right)
$$

 *  $$
    R_{\rho\sigma\mu\nu} = \frac{1}{2} \left( \frac{\partial^{2} g_{\rho\nu}}{\partial x^\sigma \partial x^\mu} + \frac{\partial^{2} g_{\sigma\mu}}{\partial x^\rho \partial x^\nu} - \frac{\partial^{2} g_{\rho\mu}}{\partial x^\sigma \partial x^\nu} - \frac{\partial^{2} g_{\sigma\nu}}{\partial x^\rho \partial x^\mu} \right) + g^{\lambda\kappa} \left( \Gamma_{\rho\sigma\lambda} \Gamma_{\mu\nu\kappa} - \Gamma_{\rho\nu\lambda} \Gamma_{\sigma\mu\kappa} \right) = \frac{1}{2} \left( \frac{\partial^{2} g_{\rho\nu}}{\partial x^\sigma \partial x^\mu} + \frac{\partial^{2} g_{\sigma\mu}}{\partial x^\rho \partial x^\nu} - \frac{\partial^{2} g_{\rho\mu}}{\partial x^\sigma \partial x^\nu} - \frac{\partial^{2} g_{\sigma\nu}}{\partial x^\rho \partial x^\mu} \right) + g^{\lambda\kappa} \left( \Gamma_{\rho\sigma\lambda} \Gamma_{\mu\nu\kappa} - \Gamma_{\rho\nu\lambda} \Gamma_{\sigma\mu\kappa} \right)
    $$

1.  $$
    R_{\rho\sigma\mu\nu} = \frac{1}{2} \left( \frac{\partial^{2} g_{\rho\nu}}{\partial x^\sigma \partial x^\mu} + \frac{\partial^{2} g_{\sigma\mu}}{\partial x^\rho \partial x^\nu} - \frac{\partial^{2} g_{\rho\mu}}{\partial x^\sigma \partial x^\nu} - \frac{\partial^{2} g_{\sigma\nu}}{\partial x^\rho \partial x^\mu} \right) + g^{\lambda\kappa} \left( \Gamma_{\rho\sigma\lambda} \Gamma_{\mu\nu\kappa} - \Gamma_{\rho\nu\lambda} \Gamma_{\sigma\mu\kappa} \right) = \frac{1}{2} \left( \frac{\partial^{2} g_{\rho\nu}}{\partial x^\sigma \partial x^\mu} + \frac{\partial^{2} g_{\sigma\mu}}{\partial x^\rho \partial x^\nu} - \frac{\partial^{2} g_{\rho\mu}}{\partial x^\sigma \partial x^\nu} - \frac{\partial^{2} g_{\sigma\nu}}{\partial x^\rho \partial x^\mu} \right) + g^{\lambda\kappa} \left( \Gamma_{\rho\sigma\lambda} \Gamma_{\mu\nu\kappa} - \Gamma_{\rho\nu\lambda} \Gamma_{\sigma\mu\kappa} \right)
    $$

`this is a really really really really really really really really really really really really really really really really really really really really really long inline code span`

* `this is a really really really really really really really really really really really really really really really really really really really really really long inline code span`

```python
print("this is a really really really really really really really really really really really really really really really really really really really really really long inline code block")
```


*   ```python
    print("this is a really really really really really really really really really really really really really really really really really really really really really long inline code block")
    ```

Where:
- $R_{\rho\sigma\mu\nu}$ is the Riemann curvature tensor.
- $g_{\mu\nu}$ is the metric tensor.
- $\Gamma_{\mu\nu\lambda}$ are the Christoffel symbols of the first kind, defined by:
  $$
  \Gamma_{\mu\nu\lambda} = \frac{1}{2} \left( \frac{\partial g_{\mu\nu}}{\partial x^\lambda} + \frac{\partial g_{\mu\lambda}}{\partial x^\nu} - \frac{\partial g_{\nu\lambda}}{\partial x^\mu} \right)
  $$
- $g^{\lambda\kappa}$ is the inverse metric tensor, satisfying $g^{\lambda\kappa} g_{\kappa\nu} = \delta^\lambda{}_\nu$.
- $x^\mu$ represents the coordinates in the manifold.

This equation encapsulates how the curvature of a manifold is derived from its metric, which is fundamental in general relativity and differential geometry.

**Explanation:**

The Riemann curvature tensor $R_{\rho\sigma\mu\nu}$ measures the extent to which the metric tensor $g_{\mu\nu}$ is not locally isometric to Euclidean space. It plays a crucial role in Einstein's field equations and provides insight into the gravitational field's tidal forces.

The tensor is constructed using second derivatives of the metric tensor and products of the Christoffel symbols, which themselves are derived from first derivatives of the metric tensor. The complexity of this equation is due to the intricate relationships between these components, reflecting the geometric properties of spacetime.

# HTML and MDX Testing

<Preview>
  <PreviewExample/>
</Preview>

<Preview>
  <YouTube 
    videoId="by9PUlqtJlM"
    className="rounded-xl"
    caption="A Test Video"
  />
</Preview>



> This guide is an abstraction from Github's Formatting Syntax documentation.[^1]\
> We are using it to show the various styles that we have available.

# Headings

To create a heading, add one to two <kbd>#</kbd> symbols before your heading text. The number of <kbd>#</kbd> you use will determine the hierarchy level and typeface size of the heading.

<Preview codeblock>
  <div>
    <h1>Heading 1</h1>
    <div/>
    <h2>Heading 2</h2>
  </div>
</Preview>

```text
# Heading 1
## Heading 2
```

# Styling Text

You can indicate emphasis with bold, italic, strikethrough, subscript, or superscript text in comment fields and .md files.

<Preview codeblock>
  <div>**Bold**</div>
  <div>*Italic*</div>
  <div>~~Strikethrough~~</div>
  <div><sub>Subscript</sub></div>
  <div><sup>Superscript</sup></div>
  <div><kbd>⌘</kbd><kbd>K</kbd></div>
</Preview>

```text
**Bold**
*Italic*
~~Strikethrough~~
<sub>Subscript</sub>
<sup>Superscript</sup>
<kbd>⌘</kbd><kbd>K</kbd>
```

# Quoting Text

You can quote text with a <kbd>></kbd>.

<Preview codeblock>
  Text that is not a quote
  > Text that is a quote
</Preview>
```text
Text that is not a quote
> Text that is a quote
```

# Links

You can create an inline link by wrapping link text in brackets, and then wrapping the URL in parentheses.

<Preview codeblock>
  [Link](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
</Preview>
```text
[Link](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
```

# Lists

You can make an unordered list by preceding one or more lines of text with <kbd>-</kbd>.

<Preview codeblock>
  - George Washington
  - John Adams
  - Thomas Jefferson
</Preview>
```text
- George Washington
- John Adams
- Thomas Jefferson
```
To order your list, precede each line with a number.

<Preview codeblock>
  1. James Madison
  2. James Monroe
  3. John Quincy Adams
</Preview>
```text
1. James Madison
2. James Monroe
3. John Quincy Adams
```

# Footnotes

You can add footnotes to your content by using this bracket syntax <kbd>`[^1]`</kbd> and then defining the footnote at the bottom of your content.


# Preview

You can preview your markdown content in real-time by using the preview feature in the editor. We have been using it throughout this guide to show you how your markdown content will look when rendered. It comes with a single prop, <kbd>codeblock</kbd>, that you can use to display the code block right below the preview.

```tsx
<Preview>
  <div className="bg-gray-2 border-gray-4 border w-32 h-16 rounded"/>
</Preview>
```

# Inline Code

Append <kbd>`{:lang}{:js}`</kbd> (e.g. <kbd>`{:js}{:js}`</kbd>) to the end of inline code to highlight it like a regular code block.

```text
This is an array `[1, 2, 3]{:js}` of numbers 1 through 3.
```


# Code Blocks

To format code or text into its own distinct block, use triple backticks.
 
```tsx
function feature() {
  return "It works in my environment.";
}
```

# Media

You can embed images, videos, and other media in your markdown content. You can also add captions to your images via the <kbd>`<Image/>`</kbd> component.

<Preview codeblock>
<div className="flex flex-row gap-4">
  <Image src='https://avatar.vercel.sh/sylph' alt='Placeholder' caption='Avatar'/>
</div>
</Preview>
```text
<Image src='https://avatar.vercel.sh/sylph' alt='Placeholder' caption='Avatar'/>
```

# Tables

You can create tables by assembling a list of words and dividing them with hyphens <kbd>-</kbd> (for the first row), and then separating each column with a pipe <kbd>|</kbd>.

```text
| First Header  | Second Header |
| ------------- | ------------- |
| Content Cell  | Content Cell  |
| Content Cell  | Content Cell  |
```

[^1]: Github, ["Basic Writing and Formatting Syntax"](https://docs.github.com/en/github/writing-on-github/basic-writing-and-formatting-syntax) Github, 2024. [Accessed: 19-Sep-2024].
