package service

import (
	"context"
	"strings"

	"github.com/junaili/ethan-chess-service/pkg/handler"
	pb "github.com/junaili/ethan-chess-service/pkg/pb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type ChessServiceServer struct {
	pb.UnimplementedChessServiceServer
}

func NewChessServiceServer() *ChessServiceServer {
	return &ChessServiceServer{}
}

func (s *ChessServiceServer) SendInvite(_ context.Context, req *pb.SendInviteRequest) (*pb.SendInviteResponse, error) {
	if !strings.Contains(req.To, "@") {
		return nil, status.Errorf(codes.InvalidArgument, "invalid email address")
	}
	if req.FromName == "" || req.InviteLink == "" {
		return nil, status.Errorf(codes.InvalidArgument, "from_name and invite_link are required")
	}

	if err := handler.SendInviteEmail(handler.InviteRequest{
		To:         req.To,
		FromName:   req.FromName,
		InviteLink: req.InviteLink,
	}); err != nil {
		return nil, status.Errorf(codes.Internal, "email delivery failed: %v", err)
	}

	return &pb.SendInviteResponse{Ok: true}, nil
}

func (s *ChessServiceServer) LookupByEmail(_ context.Context, req *pb.LookupByEmailRequest) (*pb.LookupByEmailResponse, error) {
	email := strings.TrimSpace(req.Email)
	if email == "" || !strings.Contains(email, "@") {
		return nil, status.Errorf(codes.InvalidArgument, "valid email required")
	}

	result, err := handler.LookupEmailInIAM(email)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "lookup failed: %v", err)
	}

	return &pb.LookupByEmailResponse{
		Found:       result.Found,
		UserId:      result.UserID,
		DisplayName: result.DisplayName,
	}, nil
}
