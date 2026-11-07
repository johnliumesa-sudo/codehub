// The turtle module Python games get when they `import turtle` (written to the Pyodide file system;
// see python.js). Generated from a plain Python file; keep it free of backslashes and backticks.
export const TURTLE_PY = `# Codehub turtle: the common turtle API drawn on the game page's <canvas id="canvas"> (Pyodide has no
# tkinter). Animation uses time.sleep, which the Codehub prelude routes through JSPI so the browser paints.
import math, time
from js import document

_stage = document.getElementById("cx-stage")
_canvas = document.getElementById("canvas")
_stage.hidden = False
_ctx = _canvas.getContext("2d")
_W, _H = _canvas.width, _canvas.height
_bg = "white"
_ctx.fillStyle = _bg
_ctx.fillRect(0, 0, _W, _H)
_DELAYS = {0: 0.0, 1: 0.05, 2: 0.04, 3: 0.03, 4: 0.025, 5: 0.02, 6: 0.016, 7: 0.012, 8: 0.008, 9: 0.005, 10: 0.003}
_NAMES = {"fastest": 0, "fast": 10, "normal": 6, "slow": 3, "slowest": 1}
_keys = {}


def _xy(x, y):
    return _W / 2 + x, _H / 2 - y


def _point(x, y):
    # A point given as (x, y), as one pair (tuple, list, Vec2D) or as another turtle.
    if y is not None:
        return float(x), float(y)
    if isinstance(x, Turtle):
        return x._x, x._y
    a, b = x
    return float(a), float(b)


class Turtle:
    def __init__(self):
        self._x = self._y = 0.0
        self._h = 0.0
        self._down = True
        self._pen = "black"
        self._fill = "black"
        self._w = 1
        self._delay = _DELAYS[6]
        self._poly = None

    def _line_to(self, x, y):
        if self._down:
            _ctx.beginPath()
            _ctx.strokeStyle = self._pen
            _ctx.lineWidth = self._w
            _ctx.lineCap = "round"
            _ctx.moveTo(*_xy(self._x, self._y))
            _ctx.lineTo(*_xy(x, y))
            _ctx.stroke()
        if self._poly is not None:
            self._poly.append((x, y))
        self._x, self._y = x, y
        if self._delay:
            time.sleep(self._delay)

    def forward(self, d):
        r = math.radians(self._h)
        self._line_to(self._x + d * math.cos(r), self._y + d * math.sin(r))

    def backward(self, d):
        self.forward(-d)

    def left(self, a):
        self._h = (self._h + a) % 360

    def right(self, a):
        self.left(-a)

    def goto(self, x, y=None):
        x, y = _point(x, y)
        self._line_to(x, y)

    def setheading(self, a):
        self._h = float(a) % 360

    def home(self):
        self.goto(0, 0)
        self.setheading(0)

    def circle(self, radius, extent=360, steps=None):
        steps = steps or max(12, int(abs(extent) / 6))
        step = extent / steps
        length = 2 * radius * math.sin(math.radians(step) / 2)
        delay, self._delay = self._delay, self._delay / 4
        self.left(step / 2)
        for _ in range(steps):
            self.forward(length)
            self.left(step)
        self.left(-step / 2)
        self._delay = delay

    def dot(self, size=5, color=None):
        _ctx.beginPath()
        _ctx.fillStyle = color or self._pen
        _ctx.arc(*_xy(self._x, self._y), size / 2, 0, 2 * math.pi)
        _ctx.fill()

    def write(self, text, move=False, align="left", font=("Arial", 12, "normal")):
        _ctx.fillStyle = self._pen
        _ctx.font = f"{font[2] if len(font) > 2 else ''} {font[1]}px {font[0]}"
        _ctx.textAlign = align
        _ctx.fillText(str(text), *_xy(self._x, self._y))

    def penup(self):
        self._down = False

    def pendown(self):
        self._down = True

    def pensize(self, w=None):
        if w is None:
            return self._w
        self._w = w

    def speed(self, s=None):
        if s is None:
            return self._delay
        s = _NAMES.get(s, s)
        self._delay = _DELAYS.get(int(s) if 0 <= int(s) <= 10 else 0, 0.0)

    def color(self, pen, fill=None):
        self._pen, self._fill = pen, fill or pen

    def pencolor(self, c):
        self._pen = c

    def fillcolor(self, c):
        self._fill = c

    def begin_fill(self):
        self._poly = [(self._x, self._y)]

    def end_fill(self):
        if self._poly and len(self._poly) > 2:
            _ctx.beginPath()
            _ctx.fillStyle = self._fill
            _ctx.moveTo(*_xy(*self._poly[0]))
            for p in self._poly[1:]:
                _ctx.lineTo(*_xy(*p))
            _ctx.closePath()
            _ctx.fill()
        self._poly = None

    def pos(self):
        return (round(self._x, 2), round(self._y, 2))

    def xcor(self):
        return self._x

    def ycor(self):
        return self._y

    def heading(self):
        return self._h

    def clear(self):
        _ctx.fillStyle = _bg
        _ctx.fillRect(0, 0, _W, _H)

    def reset(self):
        self.clear()
        self.__init__()

    def towards(self, x, y=None):
        x, y = _point(x, y)
        return math.degrees(math.atan2(y - self._y, x - self._x)) % 360

    def distance(self, x, y=None):
        x, y = _point(x, y)
        return math.hypot(x - self._x, y - self._y)

    def shape(self, name=None):
        return "classic"

    def hideturtle(self):
        pass

    def showturtle(self):
        pass

    fd, bk, back, lt, rt = forward, backward, backward, left, right
    pu, up, pd, down, width = penup, penup, pendown, pendown, pensize
    setpos = setposition = goto
    seth = setheading
    position = pos
    ht, st = hideturtle, showturtle


class _Screen:
    def bgcolor(self, c):
        global _bg
        _bg = c
        _ctx.fillStyle = c
        _ctx.fillRect(0, 0, _W, _H)

    def title(self, t):
        document.title = str(t)

    def setup(self, *a, **k):
        pass

    def tracer(self, *a, **k):
        pass

    def update(self):
        time.sleep(0)

    def clear(self):
        _ctx.fillStyle = _bg
        _ctx.fillRect(0, 0, _W, _H)

    def window_width(self):
        return _W

    def window_height(self):
        return _H

    def ontimer(self, fun, t=0):
        from js import window
        from pyodide.ffi import create_once_callable
        window.setTimeout(create_once_callable(lambda: fun()), int(t))

    def onscreenclick(self, fun, btn=1):
        from js import window
        from pyodide.ffi import create_proxy

        def on_click(e):
            r = _canvas.getBoundingClientRect()
            sx = _W / r.width if r.width else 1
            sy = _H / r.height if r.height else 1
            fun((e.clientX - r.left) * sx - _W / 2, _H / 2 - (e.clientY - r.top) * sy)

        _canvas.addEventListener("click", create_proxy(on_click))

    onclick = onscreenclick

    def textinput(self, title, prompt):
        return input(f"{prompt} ")

    def numinput(self, title, prompt, default=None, minval=None, maxval=None):
        v = input(f"{prompt} ").strip()
        if not v and default is not None:
            return default
        return float(v)

    def onkey(self, fun, key):
        _keys[key] = fun

    onkeypress = onkey

    def listen(self):
        pass

    def mainloop(self):
        # Keep the program alive and run key handlers until the frame is closed.
        from js import window
        from pyodide.ffi import create_proxy

        def on_key(e):
            f = _keys.get(e.key) or _keys.get({"ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right", " ": "space"}.get(e.key, ""))
            if f:
                f()

        window.addEventListener("keydown", create_proxy(on_key))

    done = exitonclick = mainloop


_screen = _Screen()
Pen = RawTurtle = Turtle
_default = None


def Screen():
    return _screen


def _t():
    global _default
    if _default is None:
        _default = Turtle()
    return _default


for _n in ("forward fd backward bk back left lt right rt goto setpos setposition setheading seth home circle dot write "
           "penup pu up pendown pd down pensize width speed color pencolor fillcolor begin_fill end_fill pos position "
           "xcor ycor heading hideturtle ht showturtle st clear reset towards distance shape").split():
    globals()[_n] = (lambda n: lambda *a, **k: getattr(_t(), n)(*a, **k))(_n)
for _n in ("bgcolor title setup tracer update onkey onkeypress listen mainloop done exitonclick ontimer onscreenclick "
           "textinput numinput window_width window_height").split():
    globals()[_n] = getattr(_screen, _n)
`;
