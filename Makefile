PORT ?= 8000

# luajit if it's here, plain lua5.1 otherwise. same C API either way.
LUAPKG := $(shell pkg-config --exists luajit && echo luajit || echo lua)
LUACFLAGS := $(shell pkg-config --cflags $(LUAPKG))
LUALIBS   := $(shell pkg-config --libs   $(LUAPKG))

CC     ?= cc
CFLAGS ?= -std=gnu99 -Wall -Wextra -Wshadow -O2 -g
LDLIBS  = $(LUALIBS)

OBJ = src/arena.o src/loam.o src/garden.o

.PHONY: all run check check-hookd clean

all: garden hookd

garden: $(OBJ)
	$(CC) $(CFLAGS) -o $@ $(OBJ) $(LDLIBS)

# The deploy hook and the gallery. No lua and no libcrypto: it hashes sixty
# bytes and runs one script, and linking a TLS stack for that is the kind of
# dependency this repo is written without.
hookd: src/hookd.o
	$(CC) $(CFLAGS) -o $@ $<

src/hookd.o: src/hookd.c
	$(CC) $(CFLAGS) -c $< -o $@

src/%.o: src/%.c src/loam.h src/arena.h
	$(CC) $(CFLAGS) $(LUACFLAGS) -c $< -o $@

# run it yourself: ./garden [port]
run: garden
	@echo "run it with:  ./garden $(PORT)"

# weight budget. fails loud rather than warning politely.
check:
	@fail=0; \
	for f in $$(find site -type f 2>/dev/null); do \
	  b=$$(du -sb $$f | cut -f1); \
	  if [ $$b -gt 512000 ]; then echo "OVER 500K: $$f ($$b b)"; fail=1; fi; \
	done; \
	[ $$fail -eq 0 ] && echo "weight ok" || exit 1
	@$(MAKE) --no-print-directory check-hookd

# A hash you wrote yourself is worth its vectors. FIPS 180-4 and RFC 4231.
check-hookd: hookd
	@./hookd -t

clean:
	rm -f garden hookd $(OBJ) src/hookd.o

# ---------- wasm ----------
# freestanding: no libc, no emscripten, no toolchain beyond clang + wasm-ld.
WASM_SRC = $(wildcard src/wasm/*.c)
WASM_OUT = $(patsubst src/wasm/%.c,site/wasm/%.wasm,$(WASM_SRC))
WASMFLAGS = --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export-all \
            -Wl,--allow-undefined -O3 -flto

wasm: $(WASM_OUT)

site/wasm/%.wasm: src/wasm/%.c
	@mkdir -p site/wasm
	clang $(WASMFLAGS) -o $@ $<
	@printf "  %-14s %6s\n" "$(notdir $@)" "$$(du -h $@ | cut -f1)"

.PHONY: wasm
