package common

import (
	"context"
	"net/http"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	pb "github.com/junaili/ethan-chess-service/pkg/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type Gateway struct {
	mux      *runtime.ServeMux
	basePath string
}

func NewGateway(ctx context.Context, grpcEndpoint, basePath, internalToken string) (*Gateway, error) {
	mux := runtime.NewServeMux(runtime.WithMetadata(func(_ context.Context, _ *http.Request) metadata.MD {
		return metadata.Pairs("x-internal-gateway-token", internalToken)
	}))
	opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	if err := pb.RegisterChessServiceHandlerFromEndpoint(ctx, mux, grpcEndpoint, opts); err != nil {
		return nil, err
	}
	return &Gateway{mux: mux, basePath: basePath}, nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	http.StripPrefix(g.basePath, g.mux).ServeHTTP(w, r)
}
