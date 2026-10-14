"""Arbre HTML minimal (bibliothèque standard, html.parser), pour lire les cartes de concert des
pages agenda : texte d'un bloc, liens qu'il contient, bloc parent.

Tolérant aux pages mal formées : une balise fermante sans ouvrante est ignorée, une balise non
fermée est close avec son parent.
"""
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
HIDDEN = {"script", "style", "noscript", "svg", "template", "head", "iframe"}
# Fins de balise implicites : élément ouvert -> (éléments qu'il ferme, éléments où la recherche s'arrête)
IMPLIED = {
    "li": ({"li"}, {"ul", "ol", "menu"}),
    "dt": ({"dt", "dd"}, {"dl"}),
    "dd": ({"dt", "dd"}, {"dl"}),
    "tr": ({"tr", "td", "th"}, {"table", "thead", "tbody", "tfoot"}),
    "td": ({"td", "th"}, {"tr", "table"}),
    "th": ({"td", "th"}, {"tr", "table"}),
    "thead": ({"thead", "tbody", "tr", "td", "th"}, {"table"}),
    "tbody": ({"thead", "tbody", "tr", "td", "th"}, {"table"}),
    "option": ({"option"}, {"select", "datalist"}),
}
# Blocs qui ferment un paragraphe <p> resté ouvert
BLOCKS = {"p", "div", "ul", "ol", "dl", "table", "section", "article", "header", "footer", "aside", "nav",
          "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "figure", "form", "pre", "hr", "address", "main"}
BOUNDARY_ALL = {"div", "section", "article", "li", "td", "th", "table", "ul", "ol", "body", "main", "a",
                "header", "footer", "aside", "nav", "figure", "form", "blockquote", "button"}


class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.children, self.parent = tag, attrs, [], parent

    def _walk(self):
        """Nœuds et textes du bloc dans l'ordre du document, sans descendre dans les blocs cachés
        (parcours sans récursion : les pages mal formées peuvent être très profondes)."""
        stack = [iter(self.children)]
        while stack:
            child = next(stack[-1], None)
            if child is None:
                stack.pop()
                continue
            yield child
            if isinstance(child, Node) and child.tag not in HIDDEN:
                stack.append(iter(child.children))

    def texts(self):
        """Morceaux de texte visibles du bloc, dans l'ordre (sans scripts ni styles)."""
        return [c for c in self._walk() if isinstance(c, str)]

    def links(self):
        """Balises <a href> du bloc (lui compris), dans l'ordre du document."""
        own = [self] if self.tag == "a" and self.attrs.get("href") else []
        return own + [c for c in self._walk() if isinstance(c, Node) and c.tag == "a" and c.attrs.get("href")]


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root", {}, None)
        self.cur = self.root

    def _close_implied(self, tag):
        """Balises de fin facultatives en HTML5 (<li>, <p>, <tr>, <td>… sans fermeture) : un
        nouvel élément de la même famille ferme le précédent, sans dépasser la liste, le tableau
        ou le bloc qui les contient."""
        rule = IMPLIED.get(tag)
        if tag in BLOCKS:
            rule = ({"p"} | (rule[0] if rule else set()), BOUNDARY_ALL)
        if not rule:
            return
        closes, stops = rule
        # Le plus haut élément de la famille avant la limite : « <tr><td>A<td>B<tr> » ferme la
        # cellule ET la ligne précédente
        node, outer = self.cur, None
        while node is not None and node.tag != "root" and node.tag not in stops:
            if node.tag in closes:
                outer = node
            node = node.parent
        if outer is not None:
            self.cur = outer.parent

    def handle_starttag(self, tag, attrs):
        self._close_implied(tag)
        node = Node(tag, {k: v or "" for k, v in attrs}, self.cur)
        self.cur.children.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, {k: v or "" for k, v in attrs}, self.cur))

    def handle_endtag(self, tag):
        node = self.cur
        while node is not None and node.tag != tag:
            node = node.parent
        if node is not None and node.parent is not None:
            self.cur = node.parent

    def handle_data(self, data):
        if data.strip():
            self.cur.children.append(data)


def text_sizes(root):
    """{id(nœud): longueur du texte visible du bloc}, calculé en un seul parcours (sans récursion)."""
    sizes, stack = {}, [(root, False)]
    while stack:
        node, done = stack.pop()
        if done:
            sizes[id(node)] = sum(len(c) if isinstance(c, str) else sizes.get(id(c), 0)
                                  for c in node.children if isinstance(c, str) or c.tag not in HIDDEN)
            continue
        stack.append((node, True))
        stack.extend((c, False) for c in node.children if isinstance(c, Node) and c.tag not in HIDDEN)
    return sizes


def parse(page):
    builder = _Builder()
    try:
        builder.feed(page)
        builder.close()
    except Exception:  # noqa: BLE001  page très mal formée : on garde ce qui a été lu
        pass
    return builder.root
