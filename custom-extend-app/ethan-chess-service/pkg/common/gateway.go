package common

import (
	"context"
	"net/http"

	pb "github.com/junaili/ethan-chess-service/pkg/pb"
	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type Gateway struct {
	mux      *runtime.ServeMux
	basePath string
}

func NewGateway(ctx context.Context, grpcEndpoint, basePath string) (*Gateway, error) {
	mux := runtime.NewServeMux()
	opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	if err := pb.RegisterChessServiceHandlerFromEndpoint(ctx, mux, grpcEndpoint, opts); err != nil {
		return nil, err
	}
	return &Gateway{mux: mux, basePath: basePath}, nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	http.StripPrefix(g.basePath, g.mux).ServeHTTP(w, r)
}
