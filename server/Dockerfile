FROM --platform=$BUILDPLATFORM golang:1.25 AS build

ARG TARGETOS TARGETARCH

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
    && rm -rf /var/lib/apt/lists/*

COPY go.mod go.sum ./

RUN go mod download

COPY zooid zooid
COPY cmd cmd

RUN set -eux; \
    if [ "$TARGETARCH" = "arm64" ]; then export CC=aarch64-linux-gnu-gcc; fi; \
    CGO_ENABLED=1 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -o bin/zooid cmd/relay/main.go

FROM gcr.io/distroless/base-debian12 AS run

WORKDIR /

COPY --from=build /app/bin/zooid /bin/zooid
COPY templates /templates
COPY static /static

USER nonroot:nonroot

EXPOSE 3334

ENV CONFIG=/app/config
ENV MEDIA=/app/media
ENV DATA=/app/data

ENTRYPOINT ["/bin/zooid"]
